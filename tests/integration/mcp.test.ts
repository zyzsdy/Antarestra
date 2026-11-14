import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import Database from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import ai, { type RunContext, type StructuredToolResult, type Tool } from '@antarestra/ai'
import WebUI from '@antarestra/webui'
import mcp, { type ServerView } from '@antarestra/plugin-mcp'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse'
import { createMcpServer } from '../fixtures/mcp-server.js'
import { listenForTest } from '../../scripts/test-listen.js'
const contexts: Context[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const close of closers.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function input(overrides: Record<string, unknown> = {}) {
  return {
    revision: 1,
    name: '测试服务器',
    description: '文件工具',
    activationDescription: '需要文件时使用',
    transport: 'streamable-http',
    enabled: true,
    url: '',
    command: '',
    args: [],
    cwd: '',
    headers: {},
    env: {},
    prefixEnabled: false,
    prefix: '',
    ...overrides,
  }
}
function runContext(signal = new AbortController().signal): RunContext {
  return {
    runId: 'test',
    conversationId: 'test',
    workspaceId: 'space',
    actorId: 'actor',
    signal,
    agent: {
      id: 'test',
      title: '测试',
      version: '1',
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
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.use(Database)
  await ctx.use(database, { filename: ':memory:' })
  await ctx.use(Server, { host: '127.0.0.1', port: 0 })
  await ctx.use(rbac)
  const core = await ctx.use(ai, {})
  const registration = vi.spyOn(ctx.ai, 'registerTool')
  const fiber = await ctx.use(mcp)
  const latest = (id: string): Tool =>
    registration.mock.calls.filter(([, tool]) => tool.id === id).at(-1)![1]
  return { ctx, core, fiber, latest }
}
async function remote(
  kind: 'streamable-http' | 'sse',
  label = '远端',
  options: NonNullable<Parameters<typeof createMcpServer>[1]> & { stateful?: boolean } = {},
) {
  const connections: ReturnType<typeof createMcpServer>[] = []
  const transports = new Map<string, SSEServerTransport>()
  const httpTransports = new Map<string, NodeStreamableHTTPServerTransport>()
  const headers: {
    method: string
    authorization: string | undefined
    custom: string | string[] | undefined
  }[] = []
  const instance = createServer(async (req, res) => {
    headers.push({
      method: req.method!,
      authorization: req.headers.authorization,
      custom: req.headers['x-test'],
    })
    if (req.headers.authorization !== 'Bearer fixture-secret') {
      res.writeHead(401).end()
      return
    }
    try {
      if (kind === 'sse' && req.method === 'POST') {
        const id = new URL(req.url!, 'http://test').searchParams.get('sessionId')!
        await transports.get(id)!.handlePostMessage(req, res)
      } else if (kind === 'sse') {
        const connection = createMcpServer(label, options)
        connections.push(connection)
        const transport = new SSEServerTransport('/messages', res)
        transports.set(transport.sessionId, transport)
        await connection.server.connect(transport)
      } else if (req.headers['mcp-session-id']) {
        await httpTransports.get(String(req.headers['mcp-session-id']))!.handleRequest(req, res)
      } else {
        const connection = createMcpServer(label, options)
        connections.push(connection)
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: options.stateful ? randomUUID : undefined,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            httpTransports.set(id, transport)
          },
        })
        await connection.server.connect(transport)
        await transport.handleRequest(req, res)
      }
    } catch {
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
  const port = await listenForTest(instance)
  closers.push(async () => {
    await Promise.all(connections.map((connection) => connection.server.close()))
    instance.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      instance.close((error) => (error ? reject(error) : resolve())),
    )
  })
  return { url: `http://127.0.0.1:${port}/mcp`, headers, connections }
}
function remoteInput(url: string, transport: 'streamable-http' | 'sse' = 'streamable-http') {
  return input({
    url,
    transport,
    headers: { Authorization: 'Bearer fixture-secret', 'X-Test': 'custom' },
  })
}
it.each(['streamable-http', 'sse'] as const)(
  '%s 真实传输发现分页工具、携带请求头并保留工具错误和结构化结果',
  async (kind) => {
    const fixture = await remote(kind, '远端', { paginated: true })
    const app = await setup()
    const saved = await app.ctx.mcp.save(remoteInput(fixture.url, kind))
    expect(saved.status).toBe('connected')
    expect(saved.tools.map((tool) => tool.id)).toEqual(['get_files', 'second_tool'])
    expect(saved.headers).toEqual({ authorization: null, 'x-test': null })
    expect(JSON.stringify(saved)).not.toContain('fixture-secret')
    const result = await app.latest('get_files').execute({ fail: true }, runContext())
    expect(result).toMatchObject({
      isError: true,
      content: {
        content: [{ type: 'text', text: '远端:get_files' }],
        structuredContent: { pid: process.pid },
      },
    })
    expect(
      fixture.headers.every(
        (value) => value.authorization === 'Bearer fixture-secret' && value.custom === 'custom',
      ),
    ).toBe(true)
    if (kind === 'sse') expect(fixture.headers.some((value) => value.method === 'GET')).toBe(true)
  },
)
it('local 启动含空格参数的子进程，传递环境变量并在卸载时回收', async () => {
  const app = await setup()
  const saved = await app.ctx.mcp.save(
    input({
      transport: 'local',
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        fileURLToPath(new URL('../fixtures/mcp-server.ts', import.meta.url)),
        '含 空格的参数',
      ],
      env: { MCP_TEST_VALUE: 'secret-local' },
    }),
  )
  expect(saved.status).toBe('connected')
  expect(saved.env).toEqual({ MCP_TEST_VALUE: null })
  const tool = app.latest('get_files')
  const result = (await tool.execute({}, runContext())) as StructuredToolResult
  expect(result).toMatchObject({
    content: { structuredContent: { env: 'secret-local', args: ['含 空格的参数'] } },
  })
  const pid = (result.content as { structuredContent: { pid: number } }).structuredContent.pid
  expect(() => process.kill(pid, 0)).not.toThrow()
  await app.fiber.dispose()
  expect(() => process.kill(pid, 0)).toThrow()
  await expect(tool.execute({}, runContext())).rejects.toThrow('失效')
})
it('覆盖内置工具、前缀并存、删除恢复；重载按持久化顺序恢复', async () => {
  const one = await remote('streamable-http', '一')
  const two = await remote('streamable-http', '二')
  const app = await setup()
  app.ctx.ai.registerTool(app.ctx, {
    id: 'get_files',
    description: '内置',
    parameters: { type: 'object' },
    execute: async () => '内置',
  })
  const first = await app.ctx.mcp.save(remoteInput(one.url))
  const second = await app.ctx.mcp.save(remoteInput(two.url))
  expect(app.ctx.ai.capabilities().tools).toEqual([{ id: 'get_files', description: '二' }])
  const prefixed = await app.ctx.mcp.save(
    { ...second, prefixEnabled: true, prefix: 'webtools_' },
    second.id,
  )
  expect(app.ctx.ai.capabilities().tools).toEqual([
    { id: 'get_files', description: '一' },
    { id: 'webtools_get_files', description: '二' },
  ])
  expect(await app.latest('webtools_get_files').execute({}, runContext())).toMatchObject({
    content: { content: [{ text: '二:get_files' }] },
  })
  await app.fiber.dispose()
  expect(app.ctx.ai.capabilities().tools).toEqual([{ id: 'get_files', description: '内置' }])
  await app.ctx.use(mcp)
  expect(app.ctx.mcp.list().map((row) => row.id)).toEqual([first.id, second.id])
  expect(app.ctx.mcp.list().every((row) => row.status === 'connected')).toBe(true)
  await app.ctx.mcp.remove(first.id, first.revision)
  expect(app.ctx.ai.capabilities().tools.find((tool) => tool.id === 'get_files')?.description).toBe(
    '内置',
  )
  await app.ctx.mcp.remove(prefixed.id, prefixed.revision)
})
it('编辑保留或删除密钥，停用回收工具；拒绝旧版本写入与非法配置', async () => {
  const fixture = await remote('streamable-http')
  const app = await setup()
  const saved = await app.ctx.mcp.save(remoteInput(fixture.url))
  const updated = await app.ctx.mcp.save(
    {
      ...saved,
      enabled: false,
      activationDescription: '查找文件时',
      headers: { authorization: null },
    },
    saved.id,
  )
  expect(updated.status).toBe('disabled')
  expect(updated.headers).toEqual({ authorization: null })
  expect(app.ctx.ai.capabilities().tools).toEqual([])
  await expect(app.ctx.mcp.save({ ...saved }, saved.id)).rejects.toMatchObject({ status: 409 })
  await expect(app.ctx.mcp.remove(saved.id, saved.revision)).rejects.toMatchObject({ status: 409 })
  await expect(
    app.ctx.mcp.save({ ...updated, prefixEnabled: true, prefix: '' }, saved.id),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    app.ctx.mcp.save({ ...updated, headers: { bad: 'a\nb' } }, saved.id),
  ).rejects.toMatchObject({ status: 400 })
  const cleared = await app.ctx.mcp.save({ ...updated, headers: {} }, saved.id)
  expect(cleared.headers).toEqual({})
})
it('连接失败保留配置且不泄露凭据，编辑后可恢复', async () => {
  const fixture = await remote('streamable-http')
  const app = await setup()
  const saved = await app.ctx.mcp.save(
    input({ url: fixture.url, headers: { Authorization: 'Bearer wrong-secret' } }),
  )
  expect(saved.status).toBe('error')
  expect(saved.tools).toEqual([])
  expect(JSON.stringify(saved)).not.toContain('wrong-secret')
  const fixed = await app.ctx.mcp.save(
    { ...saved, headers: { Authorization: 'Bearer fixture-secret' } },
    saved.id,
  )
  expect(fixed.status).toBe('connected')
})
it('SSE 工具列表变化移除旧工具；连接关闭后移除能力', async () => {
  const fixture = await remote('sse')
  const app = await setup()
  const saved = await app.ctx.mcp.save(remoteInput(fixture.url, 'sse'))
  await fixture.connections[0]!.change(['new_tool'])
  await expect
    .poll(() => app.ctx.ai.capabilities().tools.map((tool) => tool.id))
    .toEqual(['new_tool'])
  await app.ctx.mcp.remove(saved.id, saved.revision)
  expect(app.ctx.ai.capabilities().tools).toEqual([])
})
it('取消工具请求传播到 SDK，服务卸载回收连接', async () => {
  const fixture = await remote('sse', '延迟', { delay: true })
  const app = await setup()
  await app.ctx.mcp.save(remoteInput(fixture.url, 'sse'))
  const controller = new AbortController()
  const call = app.latest('get_files').execute({}, runContext(controller.signal))
  const rejected = expect(call).rejects.toThrow()
  await fixture.connections[0]!.entered
  controller.abort()
  await rejected
  await fixture.connections[0]!.cancelled
  await app.fiber.dispose()
  expect(app.ctx.ai.capabilities().tools).toEqual([])
})
it('MCP 长任务超过 60 秒继续等待，默认 10 分钟才超时并取消远端请求', async () => {
  const fixture = await remote('sse', '长任务', { delay: true })
  const app = await setup()
  await app.ctx.mcp.save(remoteInput(fixture.url, 'sse'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settled = false
  const call = Promise.resolve(app.latest('get_files').execute({}, runContext()))
  void call.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const rejected = expect(call).rejects.toThrow('MCP 工具调用失败')
  await fixture.connections[0]!.entered
  await vi.advanceTimersByTimeAsync(60_001)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(539_998)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await rejected
  vi.useRealTimers()
  await fixture.connections[0]!.cancelled
})
it('WebUI 卸载不影响连接；AI 依赖恢复从 SQLite 重新装载', async () => {
  const fixture = await remote('streamable-http')
  const app = await setup()
  await app.ctx.mcp.save(remoteInput(fixture.url))
  const webui = await app.ctx.use(WebUI)
  expect(app.ctx.webui.getEntries().map((entry) => entry.id)).toContain('mcp')
  await webui.dispose()
  expect(app.ctx.mcp.list()[0]?.status).toBe('connected')
  await app.core.dispose()
  expect(app.ctx.mcp).toBeUndefined()
  await app.ctx.use(ai, {})
  await expect.poll(() => app.ctx.mcp?.list()[0]?.status).toBe('connected')
  expect(app.ctx.ai.capabilities().tools).toHaveLength(1)
})
it('管理 API 校验登录和系统权限，响应不包含凭据，卸载移除路由', async () => {
  const app = await setup()
  app.ctx.rbac.registerPermission(app.ctx, 'admin.console.view', '控制台', ['admin'])
  const identity = await app.ctx.rbac.registerProvider(app.ctx, 'mcp-test', 'mcp-test')
  await app.ctx.database.transaction(app.ctx, async (transaction) => {
    const admin = await identity.provision(transaction, 'admin', '测试管理员')
    await app.ctx.rbac.bootstrap(transaction, admin.principalId)
    await identity.provision(transaction, 'user', '测试用户')
  })
  const admin = await identity.issue('admin')
  const user = await identity.issue('user')
  const url = `http://127.0.0.1:${app.ctx.server.address!.port}/api/mcp`
  expect((await fetch(url)).status).toBe(401)
  expect((await fetch(url, { headers: { Authorization: `Bearer ${user.token}` } })).status).toBe(
    403,
  )
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      input({
        enabled: false,
        url: 'http://localhost/mcp',
        headers: { Authorization: 'private-key' },
      }),
    ),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const saved = (await response.json()) as ServerView
  expect(saved.headers).toEqual({ authorization: null })
  await app.fiber.dispose()
  expect((await fetch(url, { headers: { Authorization: `Bearer ${admin.token}` } })).status).toBe(
    404,
  )
})

it('旧版 MCP Schema 统一转换后进入模型请求，工具图片与空间隔离正常', async () => {
  const fixture = await remote('streamable-http', '图片', {
    image: true,
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        values: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
      },
    },
  })
  const app = await setup()
  expect((await app.ctx.mcp.save(remoteInput(fixture.url))).status).toBe('connected')
  app.ctx.rbac.registerRequestSource(app.ctx, 'mcp-run', {
    id: 'mcp-run',
    resolve: async (value) => ({ actorId: 'actor', workspaceId: String(value), roles: ['user'] }),
  })
  const access = await app.ctx.ai.authorize('mcp-run', 'one')
  const other = await app.ctx.ai.authorize('mcp-run', 'two')
  app.ctx.ai.registerDriver(app.ctx, {
    id: 'test',
    generate: async (request) => {
      expect(request.tools[0]?.parameters).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { values: { type: 'array', prefixItems: [{ type: 'string' }], items: false } },
      })
      return request.messages.some((message) => message.role === 'tool')
        ? { content: [{ type: 'text', text: '已获取图片' }] }
        : { content: [{ type: 'tool-call', id: 'call', name: 'get_files', arguments: {} }] }
    },
  })
  app.ctx.ai.registerProvider(app.ctx, {
    id: 'p',
    title: '测试',
    baseUrl: '',
    driverId: 'test',
    models: [
      {
        id: 'm',
        title: '测试',
        contextWindow: 100000,
        maxOutputTokens: 1000,
        input: ['text', 'image'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
    ],
  })
  app.ctx.ai.registerBackend(app.ctx, {
    id: 'test',
    run: async (runtime) => {
      const output = await runtime.request()
      await runtime.executeTools(output.content.filter((block) => block.type === 'tool-call'))
      await runtime.request()
    },
  })
  const preset = runContext().agent
  app.ctx.ai.registerAgent(app.ctx, {
    ...preset,
    userTemplate: '{{input}}',
    models: [preset.defaultModel],
    toolIds: ['get_files'],
  })
  const conversation = await app.ctx.ai.createConversation(access, preset.id)
  const run = await app.ctx.ai.start(access, conversation.id, {
    operation: 'send',
    input: { text: '测试图片' },
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    expectedNodeId: null,
  })
  await expect
    .poll(async () => (await app.ctx.ai.getRun(access, run.id)).status)
    .not.toBe('running')
  const result = await app.ctx.ai.getRun(access, run.id)
  expect(result.status, JSON.stringify(result.error)).toBe('completed')
  expect(
    result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool-result'),
  ).toMatchObject({
    isError: false,
    images: [{ mimeType: 'image/png', width: 1, height: 1 }],
    content: { content: [{ type: 'text', text: '图片:get_files' }, { type: 'image' }] },
  })
  await expect(app.ctx.ai.getRun(other, run.id)).rejects.toMatchObject({ status: 404 })
})

it('有状态 Streamable HTTP 连接卸载时发送 DELETE 终止远端会话', async () => {
  const fixture = await remote('streamable-http', '有状态', { stateful: true })
  const app = await setup()
  const saved = await app.ctx.mcp.save(remoteInput(fixture.url))
  expect(saved.status).toBe('connected')
  await app.fiber.dispose()
  expect(fixture.headers.some((request) => request.method === 'DELETE')).toBe(true)
})
it('无效工具列表不留下部分注册，并恢复被覆盖的内置工具', async () => {
  const fixture = await remote('sse')
  const app = await setup()
  app.ctx.ai.registerTool(app.ctx, {
    id: 'get_files',
    description: '内置',
    parameters: { type: 'object' },
    execute: async () => null,
  })
  const saved = await app.ctx.mcp.save(remoteInput(fixture.url, 'sse'))
  await fixture.connections[0]!.change(['get_files', 'use_skill'])
  await expect.poll(() => app.ctx.mcp.list()[0]?.status).toBe('error')
  expect(app.ctx.ai.capabilities().tools).toEqual([{ id: 'get_files', description: '内置' }])
  expect(app.ctx.mcp.list()[0]?.id).toBe(saved.id)
})

it('握手尚未完成时卸载立即取消连接并等待子进程退出', async () => {
  const app = await setup()
  const saving = app.ctx.mcp.save(
    input({
      transport: 'local',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    }),
  )
  await expect.poll(() => app.ctx.mcp.list()[0]?.status).toBe('connecting')
  await app.fiber.dispose()
  expect((await saving).status).toBe('error')
  expect(app.ctx.ai.capabilities().tools).toEqual([])
})
