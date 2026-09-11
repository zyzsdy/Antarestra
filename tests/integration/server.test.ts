import { afterEach, describe, expect, it } from 'vitest'
import { Context, Logger } from '@antarestra/plugin-sdk'
import HttpServer from '@antarestra/plugin-server'
import type { Config } from '@antarestra/plugin-server'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { request as httpRequest, createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createPrivateKey } from 'node:crypto'
import { Readable } from 'node:stream'
import { generate } from 'selfsigned'

const contexts: Context[] = []
const directories: string[] = []

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'antarestra-server-'))
  directories.push(path)
  return path
}

async function start(config: Config = {}) {
  const ctx = context()
  const fiber = await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0, ...config })
  const address = ctx.server.address!
  const url = `${config.https ? 'https' : 'http'}://127.0.0.1:${address.port}`
  return { ctx, fiber, url }
}

function request(url: string, path: string, method = 'GET') {
  return new Promise<{
    status: number
    body: string
    headers: import('node:http').IncomingHttpHeaders
  }>((resolve, reject) => {
    const transport = url.startsWith('https:') ? httpsRequest : httpRequest
    const req = transport(url, { path, method, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('HTTP 服务与路由', () => {
  it('客户端提前断开只记录中断，回收日志事件监听', async () => {
    const { ctx, url } = await start()
    const logs: string[] = []
    ctx.logger.exporter({
      export(message) {
        logs.push(`[${message.type}] ${Logger.format({ export() {} }, message)}`)
      },
    })
    let response: import('node:http').ServerResponse | undefined
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.server.route(ctx, 'GET', '/disconnect', async (http) => {
      response = http.res
      entered()
      await waiting
      http.body = '完成'
    })
    const client = httpRequest(`${url}/api/disconnect`)
    client.on('error', () => {})
    client.end()
    try {
      await started
      const closed = new Promise<void>((resolve) => response!.once('close', resolve))
      client.destroy()
      await closed
      expect(logs).toEqual(['[warn] [http-req] GET /api/disconnect 连接中断'])
      expect(response!.listeners('finish').some((listener) => listener.name === 'finished')).toBe(
        false,
      )
      expect(response!.listeners('close').some((listener) => listener.name === 'closed')).toBe(
        false,
      )
    } finally {
      client.destroy()
      release()
    }
  })

  it('原生日志记录启动与最终状态，不记录查询参数，消费方不依赖输出器插件', async () => {
    const ctx = context()
    const logs: string[] = []
    ctx.logger.exporter({
      export(message) {
        logs.push(`[${message.type}] [${message.name}] ${Logger.format({ export() {} }, message)}`)
      },
    })
    await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
    const url = `http://127.0.0.1:${ctx.server.address!.port}`
    expect(logs).toEqual([`[info] [server] 服务已监听 ${url}`])
    ctx.server.route(ctx, 'GET', '/failure', () => {
      throw new Error('处理失败')
    })
    await request(url, '/api/health?token=secret')
    await request(url, '/missing')
    await request(url, '/api/failure')
    expect(logs).toEqual(
      expect.arrayContaining([
        '[info] [server] [http-req] GET /api/health 200',
        '[info] [server] [http-req] GET /missing 404',
        '[info] [server] [http-req] GET /api/failure 500',
      ]),
    )
    expect(logs.filter((line) => line.startsWith('[error]'))).toHaveLength(1)
    expect(logs.join('\n')).not.toMatch(/token|secret/)
  })

  it('监听就绪后返回健康状态、UTC 时间和实际地址', async () => {
    const { ctx, url } = await start()
    expect(ctx.server.publicUrl).toBe('')
    expect(ctx.server.address?.address).toBe('127.0.0.1')
    const before = Date.now()
    const response = await request(url, '/api/health')
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body)
    expect(Object.keys(body).sort()).toEqual(['status', 'time'])
    expect(body.status).toBe('ok')
    expect(new Date(body.time).toISOString()).toBe(body.time)
    expect(Date.parse(body.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(body.time)).toBeLessThanOrEqual(Date.now())
    expect((await request(url, '/health')).status).toBe(404)
    expect((await request(url, '/api/missing')).status).toBe(404)
  })

  it('路由参数、多处理函数、HEAD、OPTIONS 和 405', async () => {
    const { ctx, url } = await start({ publicUrl: 'https://example.com/base/' })
    expect(ctx.server.publicUrl).toBe('https://example.com/base/')
    ctx.server.route(
      ctx,
      'GET',
      '/users/:id/',
      async (http, next) => {
        http.state.value = '用户'
        await next()
      },
      (http) => {
        http.body = { id: http.params.id, value: http.state.value }
      },
    )
    expect(JSON.parse((await request(url, '/api/users/42?hello=1')).body)).toEqual({
      id: '42',
      value: '用户',
    })
    expect((await request(url, '/api/users/42', 'HEAD')).body).toBe('')
    expect((await request(url, '/api/users/42', 'HEAD')).status).toBe(200)
    const options = await request(url, '/api/users/42', 'OPTIONS')
    expect(options.status).toBe(200)
    expect(options.headers.allow).toContain('GET')
    expect(options.headers.allow).toContain('HEAD')
    expect((await request(url, '/api/users/42', 'POST')).status).toBe(405)
    expect((await request(url, '/users/42')).status).toBe(404)
  })

  it('拒绝重复路径、保留路径和非法注册，失败不影响已注册路由', async () => {
    const { ctx, url } = await start()
    const handler = () => {}
    ctx.server.route(ctx, 'GET', '/sample', (http) => {
      http.body = '正常'
    })
    expect(() => ctx.server.route(ctx, 'get', '/sample/', handler)).toThrow('重复')
    for (const path of ['/api', '/api/a', '/health', 'missing', '/a?x=1', '/a\\b', '/[invalid']) {
      expect(() => ctx.server.route(ctx, 'GET', path, handler)).toThrow()
    }
    expect(() => ctx.server.route(ctx, 'INVALID', '/a', handler)).toThrow()
    expect(() => ctx.server.route(ctx, 'GET', '/a')).toThrow()
    expect((await request(url, '/api/sample')).body).toBe('正常')
  })

  it('按注册顺序执行洋葱中间件，撤销只影响后续请求', async () => {
    const { ctx, url } = await start()
    const calls: string[] = []
    const remove = ctx.server.use(ctx, async (_, next) => {
      calls.push('甲前')
      await next()
      calls.push('甲后')
    })
    ctx.server.use(ctx, async (_, next) => {
      calls.push('乙前')
      await next()
      calls.push('乙后')
    })
    ctx.server.route(ctx, 'GET', '/order', (http) => {
      calls.push('路由')
      http.body = '完成'
    })
    await request(url, '/api/order')
    expect(calls).toEqual(['甲前', '乙前', '路由', '乙后', '甲后'])
    await remove()
    calls.length = 0
    await request(url, '/api/order')
    expect(calls).toEqual(['乙前', '路由', '乙后'])
  })

  it('重叠路由按注册顺序处理，路由撤销幂等且不删除新注册项', async () => {
    const { ctx, url } = await start()
    const remove = ctx.server.route(ctx, 'GET', '/items/:id', (http) => {
      http.body = '旧'
    })
    ctx.server.route(ctx, 'GET', '/items/fixed', (http) => {
      http.body = '固定'
    })
    expect((await request(url, '/api/items/fixed')).body).toBe('旧')
    await remove()
    ctx.server.route(ctx, 'GET', '/items/:id', (http) => {
      http.body = '新'
    })
    await remove()
    expect((await request(url, '/api/items/other')).body).toBe('新')
    expect((await request(url, '/api/items/fixed')).body).toBe('固定')
  })
})

describe('静态目录', () => {
  it('挂载目录与 index，优先嵌套挂载，API 不回落到静态文件', async () => {
    const root = await directory()
    const nested = await directory()
    await mkdir(join(root, 'api'))
    await mkdir(join(root, 'assets'))
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'index.html'), '<h1>首页</h1>')
    await writeFile(join(root, 'api', 'missing'), '不能暴露')
    await writeFile(join(root, 'assets', 'hello.txt'), '外层')
    await writeFile(join(nested, 'hello.txt'), '内层')
    await writeFile(join(root, '.secret'), '不能暴露')
    const { ctx, url } = await start()
    ctx.server.static(ctx, '/', root)
    const remove = ctx.server.static(ctx, '/assets/', nested)
    expect((await request(url, '/')).body).toBe('<h1>首页</h1>')
    expect((await request(url, '/assets/hello.txt')).body).toBe('内层')
    expect((await request(url, '/assets/hello.txt', 'HEAD')).body).toBe('')
    expect((await request(url, '/assets/hello.txt', 'POST')).status).toBe(404)
    for (const path of [
      '/api/missing',
      '/%61pi/missing',
      '/api%2fmissing',
      '/empty/',
      '/.secret',
      '/missing',
      '/%2e%2e/secret',
      '/assets/%5c..%5csecret',
      '/index.html:stream',
    ]) {
      expect((await request(url, path)).status).toBe(404)
    }
    expect((await request(url, '/%ZZ')).status).toBe(400)
    expect(() => ctx.server.static(ctx, '/assets', nested)).toThrow('重复')
    expect(() => ctx.server.static(ctx, '/api', root)).toThrow()
    await remove()
    expect((await request(url, '/assets/hello.txt')).body).toBe('外层')
  })

  it('拒绝通过目录链接读取挂载根目录之外的文件', async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(outside, 'secret.txt'), '外部内容')
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const { ctx, url } = await start()
    ctx.server.static(ctx, '/', root)
    expect((await request(url, '/escape/secret.txt')).status).toBe(404)
  })
})

describe('全局错误处理', () => {
  it.each([false, true])('debug=%s 捕获同步、异步及非 Error 异常并清理旧响应头', async (debug) => {
    const { ctx, url } = await start({ debug })
    const cause = new Error('原因 <script>alert(1)</script>')
    cause.cause = cause
    ctx.server.route(ctx, 'GET', '/sync', (http) => {
      http.set('Content-Encoding', 'gzip')
      http.set('Content-Length', '999999')
      http.set('Location', '/wrong')
      http.body = '旧正文'
      throw new Error('失败 <tag>', { cause })
    })
    ctx.server.route(ctx, 'GET', '/async', async () => {
      await Promise.resolve()
      throw new Error('异步失败')
    })
    ctx.server.route(ctx, 'GET', '/value', () => {
      throw '<script>值</script>'
    })
    ctx.server.route(ctx, 'GET', '/status', (http) => {
      http.throw(401, '仍返回 500')
    })
    for (const path of ['/sync', '/async', '/value', '/status']) {
      const response = await request(url, `/api${path}`)
      expect(response.status).toBe(500)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['content-encoding']).toBeUndefined()
      expect(response.headers.location).toBeUndefined()
      if (debug) {
        expect(response.headers['content-type']).toContain('text/html')
        expect(response.body).toContain('<!doctype html>')
        expect(response.body).not.toContain('<script>')
      } else {
        expect(JSON.parse(response.body)).toEqual({ error: 'Internal Server Error' })
      }
    }
    if (debug) {
      const body = (await request(url, '/api/sync')).body
      expect(body).toContain('&lt;tag&gt;')
      expect(body).toContain('&lt;script&gt;')
      expect(body).toContain('原因链包含循环')
      expect(body).toContain('server.test.ts')
    }
    expect((await request(url, '/api/sync', 'HEAD')).body).toBe('')
  })

  it('最外层捕获注册中间件在 next 前后抛出的异常', async () => {
    const { ctx, url } = await start()
    const remove = ctx.server.use(ctx, () => {
      throw new Error('前置失败')
    })
    expect((await request(url, '/api/health')).status).toBe(500)
    await remove()
    ctx.server.use(ctx, async (_, next) => {
      await next()
      throw new Error('后置失败')
    })
    expect((await request(url, '/api/health')).status).toBe(500)
  })

  it('发送响应头后抛错终止连接，后续请求仍然可用', async () => {
    const { ctx, url } = await start()
    const logs: { type: string; content: string }[] = []
    ctx.logger.exporter({
      export(message) {
        logs.push({ type: message.type, content: Logger.format({ export() {} }, message) })
      },
    })
    ctx.server.route(ctx, 'GET', '/partial', (http) => {
      http.res.writeHead(200)
      http.res.write('部分内容')
      throw new Error('已发送')
    })
    await expect(request(url, '/api/partial')).rejects.toThrow()
    expect((await request(url, '/api/health')).status).toBe(200)
    expect(logs.filter((line) => line.type === 'error')).toHaveLength(1)
    expect(logs).toContainEqual({ type: 'warn', content: '[http-req] GET /api/partial 连接中断' })
    expect(logs.some((line) => line.content === '[http-req] GET /api/partial 200')).toBe(false)
  })

  it('流在发送前出错返回 500，发送后出错终止连接', async () => {
    const { ctx, url } = await start({ debug: true })
    const logs: { type: string; content: string }[] = []
    ctx.logger.exporter({
      export(message) {
        logs.push({ type: message.type, content: Logger.format({ export() {} }, message) })
      },
    })
    ctx.server.route(ctx, 'GET', '/stream-before', (http) => {
      http.body = new Readable({
        read() {
          this.destroy(new Error('流读取失败'))
        },
      })
    })
    ctx.server.route(ctx, 'GET', '/stream-after', (http) => {
      http.body = Readable.from(
        (async function* () {
          yield '首段'
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error('流后续失败')
        })(),
      )
    })
    const response = await request(url, '/api/stream-before')
    expect(response.status).toBe(500)
    expect(response.body).toContain('流读取失败')
    await expect(request(url, '/api/stream-after')).rejects.toThrow()
    expect(logs.filter((line) => line.type === 'error')).toHaveLength(2)
    expect(logs).toContainEqual({ type: 'info', content: '[http-req] GET /api/stream-before 500' })
    // 用下一次请求确保服务端 close 事件已处理。
    await request(url, '/api/health')
    expect(logs).toContainEqual({
      type: 'warn',
      content: '[http-req] GET /api/stream-after 连接中断',
    })
  })
})

describe('配置与 HTTPS', () => {
  it.each([
    { port: -1 },
    { port: 65536 },
    { port: 1.5 },
    { port: '14451' },
    { host: '' },
    { host: 123 },
    { debug: 'true' },
    { https: 1 },
    { publicUrl: '不是地址' },
    { publicUrl: 'ftp://example.com' },
    { publicUrl: 'https://user:password@example.com' },
    { cert: false },
    { key: 1 },
    { passphraseFile: false },
    { https: true },
  ])('拒绝无效配置 %j', async (config) => {
    const ctx = context()
    await expect(ctx.plugin(HttpServer, config as Config)).rejects.toThrow()
  })

  it('HTTPS 关闭时不读取证书，端口占用时启动失败', async () => {
    const { ctx, url } = await start({ cert: '不存在', key: '不存在', passphraseFile: '不存在' })
    expect((await request(url, '/api/health')).status).toBe(200)
    await expect(
      context().plugin(HttpServer, { host: '127.0.0.1', port: ctx.server.address!.port }),
    ).rejects.toThrow()
  })

  it('HTTPS 启用时拒绝缺失或无效证书文件', async () => {
    await expect(start({ https: true, cert: '不存在', key: '不存在' })).rejects.toThrow()
    const root = await directory()
    const invalid = join(root, 'invalid.pem')
    await writeFile(invalid, '无效证书')
    await expect(start({ https: true, cert: invalid, key: invalid })).rejects.toThrow()
  })

  it('通过 HTTPS 提供健康接口，支持加密私钥及带末尾换行的密码文件', async () => {
    const root = await directory()
    // 仅在测试运行时生成，不提交任何私钥；密码两侧的空格必须保留。
    const pems = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048 })
    const cert = join(root, '证书.pem')
    const key = join(root, '私钥.pem')
    const encrypted = join(root, '加密私钥.pem')
    const password = join(root, '密码.txt')
    await writeFile(cert, pems.cert)
    await writeFile(key, pems.private)
    await writeFile(
      encrypted,
      createPrivateKey(pems.private).export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: ' 测试密码 ',
      }),
    )
    await writeFile(password, ' 测试密码 \r\n')
    const first = await start({ https: true, cert, key })
    expect(JSON.parse((await request(first.url, '/api/health')).body).status).toBe('ok')
    const second = await start({
      https: true,
      cert: relative(process.cwd(), cert),
      key: encrypted,
      passphraseFile: password,
    })
    expect((await request(second.url, '/api/health')).status).toBe(200)
    await writeFile(password, '错误密码')
    await expect(
      start({ https: true, cert, key: encrypted, passphraseFile: password }),
    ).rejects.toThrow()
  })
})

describe('server 插件生命周期', () => {
  it('消费插件卸载回收全部注册，已销毁上下文不能留下注册', async () => {
    const { ctx, url } = await start()
    const root = await directory()
    await writeFile(join(root, 'file.txt'), '文件')
    const consumer = await ctx.plugin({
      inject: ['server'],
      apply(owner: Context) {
        owner.server.use(owner, async (http, next) => {
          http.set('X-Consumer', 'active')
          await next()
        })
        owner.server.route(owner, 'GET', '/consumer', (http) => {
          http.body = '在线'
        })
        owner.server.static(owner, '/files', root)
      },
    })
    expect((await request(url, '/api/consumer')).body).toBe('在线')
    expect((await request(url, '/files/file.txt')).body).toBe('文件')
    await consumer.dispose()
    expect((await request(url, '/api/consumer')).status).toBe(404)
    expect((await request(url, '/files/file.txt')).status).toBe(404)
    expect((await request(url, '/api/health')).headers['x-consumer']).toBeUndefined()
    expect(() => ctx.server.route(consumer.ctx, 'GET', '/dead', () => {})).toThrow()
    ctx.server.route(ctx, 'GET', '/dead', (http) => {
      http.body = '新注册'
    })
    expect((await request(url, '/api/dead')).body).toBe('新注册')
  })

  it('卸载释放端口，恢复服务后依赖插件重新注册，旧实例拒绝注册', async () => {
    const { ctx, fiber, url } = await start()
    const old = ctx.server
    const port = old.address!.port
    const consumer = await ctx.plugin({
      inject: ['server'],
      apply(owner: Context) {
        owner.server.route(owner, 'GET', '/consumer', (http) => {
          http.body = '恢复'
        })
      },
    })
    await fiber.dispose()
    expect(old.address).toBeUndefined()
    expect(() => old.use(ctx, () => {})).toThrow('卸载')
    await expect(request(url, '/api/health')).rejects.toThrow()
    await ctx.plugin(HttpServer, { host: '127.0.0.1', port })
    await consumer.await()
    expect((await request(url, '/api/consumer')).body).toBe('恢复')
  })

  it('不同上下文的监听与注册互相独立', async () => {
    const first = await start()
    const second = await start()
    first.ctx.server.route(first.ctx, 'GET', '/only', (http) => {
      http.body = '甲'
    })
    expect((await request(second.url, '/api/only')).status).toBe(404)
    await first.fiber.dispose()
    expect((await request(second.url, '/api/health')).status).toBe(200)
  })

  it('等待在途请求完成后卸载，端口可以重新监听', async () => {
    const { ctx, fiber, url } = await start()
    const port = ctx.server.address!.port
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.server.route(ctx, 'GET', '/wait', async (http) => {
      entered()
      await waiting
      http.body = '已完成'
    })
    const response = request(url, '/api/wait')
    await started
    const disposed = fiber.dispose()
    release()
    expect((await response).body).toBe('已完成')
    await disposed
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    )
  })

  it('超过五秒关闭残余连接，卸载不被未完成请求永久阻塞', async () => {
    const { ctx, fiber, url } = await start()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.server.route(ctx, 'GET', '/blocked', async (http) => {
      entered()
      await waiting
      http.body = '完成'
    })
    const rejected = expect(request(url, '/api/blocked')).rejects.toThrow()
    await started
    try {
      await fiber.dispose()
      await rejected
      expect(ctx.server).toBeUndefined()
    } finally {
      release()
    }
  }, 10000)

  it('正在处理的请求保留旧快照，新请求使用撤销后的快照', async () => {
    const { ctx, url } = await start()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const remove = ctx.server.route(ctx, 'GET', '/snapshot', async (http) => {
      entered()
      await waiting
      http.body = '旧快照'
    })
    const first = request(url, '/api/snapshot')
    await started
    await remove()
    ctx.server.route(ctx, 'GET', '/snapshot', (http) => {
      http.body = '新快照'
    })
    try {
      expect((await request(url, '/api/snapshot')).body).toBe('新快照')
    } finally {
      release()
    }
    expect((await first).body).toBe('旧快照')
  })
})
