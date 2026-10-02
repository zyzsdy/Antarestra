import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import * as plugin from '@antarestra/http'
import { createServer, request } from 'node:http'
import { createServer as createTcpServer, connect } from 'node:net'
import type { Server, Socket } from 'node:net'

const contexts: Context[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
async function listen(server: Server) {
  servers.push(server)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  return address.port
}
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(plugin)
  return { ctx, fiber }
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('HTTP 服务', () => {
  it('复用请求解析、JSON 请求体、状态错误及调用方客户端配置', async () => {
    const port = await listen(
      createServer(async (req, res) => {
        if (req.url === '/error') {
          res.writeHead(503).end()
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString(),
            url: req.url,
          }),
        )
      }),
    )
    const { ctx } = await setup()
    const client = ctx.http.extend({ baseUrl: `http://127.0.0.1:${port}` })
    expect(await client.post('/test', { value: 1 }, { params: { q: '中文' } })).toEqual({
      method: 'POST',
      body: '{"value":1}',
      url: '/test?q=%E4%B8%AD%E6%96%87',
    })
    await expect(client.get('/error')).rejects.toMatchObject({ code: 'STATUS_ERROR' })
  })

  it('单次 HTTP 代理不影响并发直连或其他请求', async () => {
    const origin = await listen(createServer((_req, res) => res.end('目标')))
    let hits = 0
    const proxy = createServer((req, res) => {
      hits++
      const outgoing = request(req.url!, { method: req.method }, (incoming) => incoming.pipe(res))
      outgoing.on('error', () => res.destroy())
      req.pipe(outgoing)
    })
    proxy.on('connect', (req, socket, head) => {
      hits++
      const target = new URL(`http://${req.url}`)
      const remote = connect(Number(target.port), target.hostname, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        remote.write(head)
        socket.pipe(remote).pipe(socket)
      })
      socket.on('close', () => remote.destroy())
      remote.on('error', () => socket.destroy())
    })
    const port = await listen(proxy)
    const { ctx } = await setup()
    const url = `http://127.0.0.1:${origin}`
    const options = { responseType: 'text' as const }
    expect(
      await Promise.all([
        ctx.http.get(url, { ...options, proxyAgent: `http://127.0.0.1:${port}` }),
        ctx.http.get(url, options),
      ]),
    ).toEqual(['目标', '目标'])
    expect(await ctx.http.get(url, options)).toBe('目标')
    expect(hits).toBe(1)
  })

  it('SOCKS5 通过代理解析目标域名，保留后续直连能力', async () => {
    const origin = await listen(createServer((_req, res) => res.end('SOCKS 目标')))
    let destination = ''
    const port = await listen(
      createTcpServer((socket) => {
        let pending = Buffer.alloc(0)
        let greeted = false
        const receive = (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk])
          if (!greeted) {
            if (pending.length < 2 || pending.length < 2 + pending[1]!) return
            pending = pending.subarray(2 + pending[1]!)
            greeted = true
            socket.write(Buffer.from([5, 0]))
          }
          if (pending.length < 5) return
          const size = pending[3] === 3 ? pending[4]! : 4
          const offset = pending[3] === 3 ? 5 : 4
          if (pending.length < offset + size + 2) return
          destination = pending.subarray(offset, offset + size).toString()
          socket.off('data', receive)
          const remote = connect(origin, '127.0.0.1', () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            remote.write(pending.subarray(offset + size + 2))
            socket.pipe(remote).pipe(socket)
          })
          socket.on('close', () => remote.destroy())
          remote.on('error', () => socket.destroy())
        }
        socket.on('data', receive)
      }),
    )
    const { ctx } = await setup()
    expect(
      await ctx.http.get('http://proxy-only.invalid/', {
        proxyAgent: `socks5://127.0.0.1:${port}`,
        responseType: 'text',
        timeout: 3000,
      }),
    ).toBe('SOCKS 目标')
    expect(destination).toBe('proxy-only.invalid')
    expect(await ctx.http.get(`http://127.0.0.1:${origin}`, { responseType: 'text' })).toBe(
      'SOCKS 目标',
    )
  })

  it('请求超时、主动取消和服务卸载会中断请求', async () => {
    const port = await listen(createServer(() => {}))
    const { ctx, fiber } = await setup()
    const url = `http://127.0.0.1:${port}`
    await expect(ctx.http.get(url, { timeout: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController()
    const canceled = expect(ctx.http.get(url, { signal: controller.signal })).rejects.toThrow()
    controller.abort()
    await canceled
    const pending = expect(ctx.http.get(url)).rejects.toThrow()
    await fiber.dispose()
    await pending
  })

  it('调用方卸载会取消请求，依赖重新启用后可再次调用', async () => {
    let arrived!: () => void
    const ready = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const port = await listen(createServer(() => arrived()))
    const { ctx, fiber } = await setup()
    let pending!: Promise<unknown>
    let starts = 0
    const consumer = await ctx.plugin({
      inject: ['http'],
      apply(owner: Context) {
        starts++
        pending = expect(owner.http.get(`http://127.0.0.1:${port}`)).rejects.toThrow()
      },
    })
    await ready
    await fiber.dispose()
    await pending
    await ctx.plugin(plugin)
    await consumer.await()
    expect(starts).toBe(2)
    await consumer.dispose()
    await pending
  })

  it('拒绝插件级代理配置', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(plugin, { proxyAgent: 'http://127.0.0.1:1' } as never)).rejects.toThrow(
      '配置校验失败',
    )
  })

  it('响应头已返回后卸载调用方仍中止响应体，其他调用方可继续请求', async () => {
    const port = await listen(
      createServer((req, res) => {
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.write('开始')
        } else res.end('正常')
      }),
    )
    const { ctx } = await setup()
    let response!: Response
    const consumer = await ctx.plugin({
      inject: ['http'],
      async apply(owner: Context) {
        response = await owner.http(`http://127.0.0.1:${port}/stream`)
      },
    })
    const body = expect(response.text()).rejects.toThrow()
    await consumer.dispose()
    await body
    expect(await ctx.http.get(`http://127.0.0.1:${port}`, { responseType: 'text' })).toBe('正常')
  })
})
