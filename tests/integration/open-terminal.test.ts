import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import Database from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import rbac from '@antarestra/rbac'
import Server from '@antarestra/plugin-server'
import ai from '@antarestra/ai'
import type { JsonObject, RunContext, StructuredToolResult } from '@antarestra/ai'
import * as http from '@antarestra/http'
import * as terminal from '@antarestra/plugin-open-terminal'
import { compile } from '../../plugins/definitions/ai/src/utils.js'
import { TerminalClient, tailText } from '../../plugins/features/open-terminal/src/client.js'
import { bashOutputNotice } from '../../plugins/features/open-terminal/src/bash.js'
import { listenForTest } from '../../scripts/test-listen.js'

const contexts: Context[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const close of closers.splice(0)) await close()
  vi.restoreAllMocks()
})

function runContext(workspaceId = 'space', signal = new AbortController().signal): RunContext {
  return {
    runId: 'run',
    conversationId: 'conversation',
    actorId: 'actor',
    workspaceId,
    signal,
    agent: {
      id: 'agent',
      version: '1',
      title: '测试',
      backendId: 'test',
      systemTemplate: '',
      userTemplate: '',
      models: [],
      defaultModel: { providerId: 'p', modelId: 'm' },
      toolIds: [],
      skillIds: [],
      extensions: {},
    },
  }
}
async function setup(url: string, apiKey = 'test-key') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Database)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const aiFiber = await ctx.plugin(ai, {})
  const httpFiber = await ctx.plugin(http)
  const registration = vi.spyOn(ctx.ai, 'registerTool')
  const fiber = await ctx.plugin(terminal, { url, apiKey })
  const tools = new Map(registration.mock.calls.map(([, tool]) => [tool.id, tool]))
  async function call(id: string, args: JsonObject, context = runContext()) {
    const tool = tools.get(id)!
    compile(tool.parameters)(args)
    return (await tool.execute(args, context)) as StructuredToolResult
  }
  return { ctx, fiber, aiFiber, httpFiber, tools, call }
}
async function server(
  handler: (req: IncomingMessage, res: ServerResponse, body: JsonObject) => void | Promise<void>,
) {
  const instance = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      await handler(req, res, raw ? (JSON.parse(raw) as JsonObject) : {})
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })
  const port = await listenForTest(instance)
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.closeAllConnections()
        instance.close((error) => (error ? reject(error) : resolve()))
      }),
  )
  return `http://127.0.0.1:${port}/terminal/`
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}
function processState(status = 'done', output = '', offset = 1) {
  return {
    id: 'process',
    status,
    exit_code: status === 'running' ? null : 0,
    output: [{ type: 'output', data: output }],
    next_offset: offset,
    log_path: '/tmp/process.jsonl',
    truncated: false,
  }
}

it('注册固定四个工具，保留路径前缀和认证；跨工作空间共用同一会话', async () => {
  const requests: { path: string; session: unknown; user: unknown; body: JsonObject }[] = []
  const url = await server((req, res, body) => {
    expect(req.headers.authorization).toBe('Bearer test-key')
    requests.push({
      path: req.url!,
      session: req.headers['x-session-id'],
      user: req.headers['x-user-id'],
      body,
    })
    json(res, { path: '/remote/a', size: 3 })
  })
  const app = await setup(url)
  expect(app.ctx.ai.capabilities().tools.map((tool) => tool.id)).toEqual([
    'bash',
    'read',
    'write',
    'edit',
  ])
  await app.call('write', { path: 'a', content: '一' }, runContext('a'))
  await app.call('write', { path: 'a', content: '二' }, runContext('b'))
  expect(requests.map((request) => request.path)).toEqual([
    '/terminal/files/write',
    '/terminal/files/write',
  ])
  expect(new Set(requests.map((request) => request.session)).size).toBe(1)
  expect(requests.every((request) => request.user === undefined)).toBe(true)
  await app.fiber.dispose()
  expect(app.ctx.ai.capabilities().tools).toEqual([])
  await expect(app.call('write', { path: 'a', content: '三' })).rejects.toThrow('卸载')
  expect(requests).toHaveLength(2)
})

it('依赖卸载移除工具，依赖恢复重新注册且旧实现不能继续调用', async () => {
  const url = await server((_req, res) => json(res, { path: '/a', size: 1 }))
  const app = await setup(url)
  await app.httpFiber.dispose()
  await vi.waitFor(() => expect(app.ctx.ai.capabilities().tools).toEqual([]))
  await expect(app.call('write', { path: 'a', content: 'x' })).rejects.toThrow('卸载')
  await app.ctx.plugin(http)
  await vi.waitFor(() => expect(app.ctx.ai.capabilities().tools).toHaveLength(4))
  await app.aiFiber.dispose()
  await app.ctx.plugin(ai, {})
  await vi.waitFor(() => expect(app.ctx.ai.capabilities().tools).toHaveLength(4))
})

it('读取传递行范围、按 UTF-8 字节截断并提供不跳行的继续位置', async () => {
  const url = await server((req, res) => {
    const query = new URL(req.url!, 'http://test').searchParams
    expect(query.get('path')).toBe('空 格&?.txt')
    expect(query.get('start_line')).toBe('3')
    expect(query.get('end_line')).toBe('7')
    json(res, {
      path: '/remote',
      total_lines: 9,
      content: '甲'.repeat(17000) + '\n' + '乙'.repeat(200) + '\n后续\n',
    })
  })
  const app = await setup(url)
  const result = await app.call('read', { path: '空 格&?.txt', offset: 3, limit: 5 })
  expect(result.content).toContain('offset=4')
  expect(result.content).not.toContain('乙')
})

it('正确返回空文件、越界和单行过长提示', async () => {
  let content = ''
  let total = 0
  const app = await setup(await server((_req, res) => json(res, { content, total_lines: total })))
  expect((await app.call('read', { path: 'a' })).content).toBe('')
  expect(await app.call('read', { path: 'a', offset: 2 })).toMatchObject({ isError: true })
  content = '中'.repeat(18000)
  total = 1
  expect((await app.call('read', { path: 'a' })).content).toContain('bash 分段读取')
})

it('进程轮询按 offset 累计输出，保留非零退出状态和错误输出', async () => {
  const urls: string[] = []
  const app = await setup(
    await server((req, res, body) => {
      urls.push(req.url!)
      if (req.method === 'POST') {
        expect(body.command).toContain('python3 -c ')
        json(res, processState('running', '{"output":"第一段\\n', 4))
      } else json(res, { ...processState('done', '错误\\n","truncated":false}', 5), exit_code: 7 })
    }),
  )
  expect(await app.call('bash', { command: "printf '%s' '中文'" })).toMatchObject({
    isError: true,
    content: { output: '第一段\n错误\n', exitCode: 7 },
  })
  expect(urls[1]).toContain('offset=4')
})

it.each(['cancel', 'timeout', 'unload', 'http-unload'] as const)(
  '%s 会等待创建响应并强制清理远端进程',
  async (mode) => {
    let created = false
    let release: (() => void) | undefined
    let killed = false
    const url = await server(async (req, res) => {
      if (req.method === 'POST') {
        created = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        json(res, processState('running'))
      } else if (req.method === 'DELETE') {
        expect(req.url).toContain('force=true')
        killed = true
        json(res, { status: 'killed' })
      } else json(res, processState('running'))
    })
    const app = await setup(url)
    const abort = new AbortController()
    const pending = app.call(
      'bash',
      { command: 'sleep 60', ...(mode === 'timeout' ? { timeout: 0.01 } : {}) },
      runContext('a', abort.signal),
    )
    const outcome = pending.then(
      (value) => value,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(created).toBe(true))
    if (mode === 'cancel') abort.abort(new Error('用户取消'))
    const disposal =
      mode === 'unload'
        ? app.fiber.dispose()
        : mode === 'http-unload'
          ? app.httpFiber.dispose()
          : undefined
    release!()
    const result = await outcome
    await disposal
    expect(killed).toBe(true)
    if (mode === 'timeout')
      expect(result).toMatchObject({ isError: true, content: expect.stringContaining('超时') })
    else expect(result).toBeInstanceOf(Error)
  },
)

it('错误状态不泄漏密钥、不重试写入，禁止重定向携带凭据', async () => {
  let calls = 0
  const app = await setup(
    await server((_req, res) => {
      calls++
      json(res, { detail: 'bad test-key' }, 401)
    }),
  )
  const result = await app.call('write', { path: 'a', content: 'b' })
  expect(result).toMatchObject({ isError: true, content: expect.stringContaining('401') })
  expect(JSON.stringify(result)).not.toContain('test-key')
  expect(calls).toBe(1)
  const redirect = await setup(
    await server((_req, res) => {
      res.writeHead(302, { Location: '/secret' }).end()
    }),
  )
  expect(await redirect.call('read', { path: 'a' })).toMatchObject({ isError: true })
})

it('工具参数限制非法范围与混合编辑格式，配置拒绝非 HTTP 和内嵌凭据', async () => {
  const app = await setup('http://127.0.0.1:18081')
  for (const args of [
    { path: 'a', edits: [] },
    { path: 'a', oldText: '', newText: '' },
    { path: 'a', edits: [{ oldText: 'a', newText: 'b' }], oldText: 'a', newText: 'c' },
  ])
    await expect(app.call('edit', args)).rejects.toThrow('Schema')
  await expect(app.call('read', { path: 'a', offset: 0 })).rejects.toThrow('Schema')
  await expect(app.call('bash', { command: 'true', timeout: 0 })).rejects.toThrow('Schema')
  for (const url of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com?key=abc'])
    expect(() => new TerminalClient(app.ctx, { url, apiKey: 'key' })).toThrow('URL')
})

it('输出尾部按字节和行数限制且不切坏中文', () => {
  const result = tailText('前'.repeat(20000) + '\n最后')
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
  expect(result.text).not.toContain('\ufffd')
  expect(result.text.endsWith('最后')).toBe(true)
  expect(
    tailText(Array.from({ length: 3000 }, (_, i) => String(i)).join('\n')).text.split('\n'),
  ).toHaveLength(2000)
})

it('远端图片交给发起调用的会话附件服务，不伪装为 Base64 文本', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
    'base64',
  )
  const app = await setup(
    await server((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
    }),
  )
  const store = vi.spyOn(app.ctx.ai, 'storeToolImage').mockResolvedValue({
    type: 'image',
    resourceId: 'remote-image',
    mimeType: 'image/png',
    filename: 'a.png',
    size: png.length,
    width: 1,
    height: 1,
  })
  const context = runContext('image-space')
  expect(await app.call('read', { path: '/remote/a.png' }, context)).toMatchObject({
    images: [{ resourceId: 'remote-image' }],
  })
  expect(store).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ data: png, width: 1, height: 1 }),
  )
})

describe.skipIf(!process.env.OPEN_TERMINAL_TEST_URL)('真实 Open Terminal 远端验证', () => {
  const url = process.env.OPEN_TERMINAL_TEST_URL ?? ''
  const key = process.env.OPEN_TERMINAL_TEST_API_KEY ?? ''
  it.each([0, 1, 200, 201, 401, 10000])(
    'Bash %i 行边界、精确截断提示与完整输出文件读取',
    async (count) => {
      const app = await setup(url, key)
      const result = await app.call('bash', {
        command: `python3 -c "for i in range(${count}): print('line-' + str(i + 1))"`,
      })
      const content = result.content as JsonObject
      const path = String(content.outputPath)
      expect(result.isError).toBe(false)
      expect(path).toMatch(/^\/tmp\/antarestra-bash-[\da-f-]+\.log$/)
      const all = Array.from({ length: count }, (_, i) => `line-${i + 1}`)
      if (count <= 200) {
        expect(content.truncated).toBe(false)
        expect(content.output).toBe(count ? all.join('\n') + '\n' : '（无输出）')
      } else {
        expect(content.truncated).toBe(true)
        expect(content.output).toBe(
          [...all.slice(0, 100), bashOutputNotice(path), ...all.slice(-100)].join('\n') + '\n',
        )
        expect(
          (await app.call('read', { path, offset: 201, limit: 1 }, runContext('other'))).content,
        ).toContain('line-201')
      }
      expect(
        await app.call('bash', {
          command: `python3 -c "from pathlib import Path; assert len(Path('${path}').read_text().splitlines()) == ${count}"`,
        }),
      ).toMatchObject({ isError: false })
    },
  )

  it('超长中文行保持上下文预算，完整输出仍在远端，重载后可按路径读取', async () => {
    const app = await setup(url, key)
    const result = await app.call('bash', { command: 'python3 -c "print(\'中\' * 40000)"' })
    const content = result.content as JsonObject
    expect(content.truncated).toBe(true)
    expect(Buffer.byteLength(String(content.output))).toBeLessThan(50 * 1024)
    expect(content.output).not.toContain('\ufffd')
    const path = String(content.outputPath)
    await app.fiber.dispose()
    const reloaded = await setup(url, key)
    expect((await reloaded.call('read', { path })).content).toContain('超过 50 KiB')
    expect(
      await reloaded.call('bash', {
        command: `python3 -c "from pathlib import Path; assert Path('${path}').stat().st_size == 120001"`,
      }),
    ).toMatchObject({ isError: false })
  })
  it('四工具闭环、跨空间共享、多处替换基于原文件，路径及内容不会作为命令执行', async () => {
    const app = await setup(url, key)
    const path = `/tmp/antarestra-${randomUUID()}/中文 ' $() 文本.txt`
    expect(await app.call('write', { path, content: '甲\n乙\n丙\n' })).not.toHaveProperty(
      'isError',
      true,
    )
    expect(
      (await app.call('read', { path, offset: 2, limit: 1 }, runContext('other'))).content,
    ).toContain('乙\n')
    expect(
      await app.call('edit', {
        path,
        edits: [
          { oldText: '甲', newText: '乙' },
          { oldText: '乙', newText: "新 $() ' 中文" },
        ],
      }),
    ).toMatchObject({ isError: false })
    expect((await app.call('read', { path })).content).toBe("乙\n新 $() ' 中文\n丙\n")
    expect(
      await app.call('bash', { command: 'printf "bash-ok\\n"; printf "stderr-ok\\n" >&2; exit 3' }),
    ).toMatchObject({
      isError: true,
      content: { exitCode: 3, output: expect.stringContaining('bash-ok') },
    })
  })

  it('歧义、缺失和重叠编辑不修改文件，保留 BOM/CRLF', async () => {
    const app = await setup(url, key)
    const path = `/tmp/antarestra-${randomUUID()}.txt`
    const original = '\ufeffone\r\ntwo\r\none\r\n'
    await app.call('write', { path, content: original })
    for (const edits of [
      [
        { oldText: 'two', newText: 'changed' },
        { oldText: 'missing', newText: 'x' },
      ],
      [{ oldText: 'one', newText: 'x' }],
      [
        { oldText: 'one\ntwo', newText: 'x' },
        { oldText: 'two', newText: 'y' },
      ],
    ]) {
      expect(await app.call('edit', { path, edits })).toMatchObject({ isError: true })
      expect(
        await app.call('bash', {
          command: `python3 -c "from pathlib import Path; assert Path('${path}').read_bytes().hex() == '${Buffer.from(original).toString('hex')}'"`,
        }),
      ).toMatchObject({ isError: false })
    }
    expect(await app.call('edit', { path, oldText: 'two', newText: '二' })).toMatchObject({
      isError: false,
    })
    expect(
      await app.call('bash', {
        command: `python3 -c "from pathlib import Path; assert Path('${path}').read_bytes().hex() == '${Buffer.from(original.replace('two', '二')).toString('hex')}'"`,
      }),
    ).toMatchObject({ isError: false })
  })

  it('长中文编辑差异经过远端日志分块后仍保持完整字符', async () => {
    const app = await setup(url, key)
    const path = `/tmp/antarestra-${randomUUID()}.txt`
    const before = '旧'.repeat(10000)
    const after = '新'.repeat(10000)
    await app.call('write', { path, content: before })
    const result = await app.call('edit', { path, oldText: before, newText: after })
    expect(result.isError).toBe(false)
    expect(String((result.content as JsonObject).output).includes('\ufffd')).toBe(false)
    expect((await app.call('read', { path })).content).toBe(after)
  })

  it('超时真正停止远端进程，不会继续写入延迟标记', async () => {
    const app = await setup(url, key)
    const marker = `/tmp/antarestra-${randomUUID()}`
    expect(
      await app.call('bash', { command: `sleep 2; touch ${marker}`, timeout: 0.2 }),
    ).toMatchObject({ isError: true })
    expect(await app.call('bash', { command: `sleep 2.1; test ! -e ${marker}` })).toMatchObject({
      isError: false,
    })
  }, 10000)
})
