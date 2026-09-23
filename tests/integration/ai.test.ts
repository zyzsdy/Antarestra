import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import ai, { AiError } from '@antarestra/ai'
import * as agentCore from '@antarestra/plugin-ai-agent-core'
import type { Access, AgentPreset, Config, ModelDriver, RunCommand, Tool } from '@antarestra/ai'
import type { Tables } from '../../plugins/definitions/ai/src/store.js'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const model = { providerId: 'provider', modelId: 'model' }
const agent = (changes: Partial<AgentPreset> = {}): AgentPreset => ({
  id: 'assistant',
  version: '1',
  title: '测试助理',
  backendId: 'ai-agent-core',
  systemTemplate: '系统',
  userTemplate: '{{input}}',
  models: [model],
  defaultModel: model,
  toolIds: [],
  skillIds: [],
  extensions: {},
  ...changes,
})
const plain: ModelDriver = {
  id: 'driver',
  async generate() {
    return { content: [{ type: 'text', text: '回答' }] }
  },
}
async function setup(
  options: {
    filename?: string
    config?: Partial<Config>
    driver?: ModelDriver
    agent?: AgentPreset
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: options.filename ?? ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const core = await ctx.plugin(ai, options.config ?? {})
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'test',
    resolve(request) {
      const workspaceId = typeof request === 'string' ? request : 'space'
      return Promise.resolve({ actorId: 'actor', workspaceId, roles: ['user'] })
    },
  })
  const access = await ctx.ai.authorize('test', 'space')
  const other = await ctx.ai.authorize('test', 'other')
  ctx.ai.registerProvider(ctx, {
    id: 'provider',
    title: '测试连接',
    baseUrl: 'https://example.invalid',
    driverId: 'driver',
    resolveCredential: async () => 'secret-never-export',
    models: [
      {
        id: 'model',
        title: '测试模型',
        contextWindow: 10000,
        maxOutputTokens: 1000,
        thinkingLevels: ['low', 'high'],
        input: ['text', 'image', 'file'],
        output: ['text'],
        tools: true,
      },
    ],
  })
  ctx.ai.registerDriver(ctx, options.driver ?? plain)
  const backend = await ctx.plugin(agentCore)
  const removeAgent = ctx.ai.registerAgent(ctx, options.agent ?? agent())
  const conversation = await ctx.ai.createConversation(access, 'assistant')
  return { ctx, access, other, conversation, core, backend, removeAgent }
}
async function command(
  ctx: Context,
  access: Access,
  id: string,
  changes: Partial<RunCommand> = {},
): Promise<RunCommand> {
  const { conversation } = await ctx.ai.getConversation(access, id)
  return {
    operation: 'send',
    input: { text: '问题' },
    idempotencyKey: randomUUID(),
    expectedRevision: conversation.revision,
    expectedNodeId: conversation.selectedNodeId,
    ...changes,
  }
}
async function finish(ctx: Context, access: Access, id: string) {
  for (let i = 0; i < 300; i++) {
    const run = await ctx.ai.getRun(access, id)
    if (run.status !== 'running') return run
    await delay(5)
  }
  throw new Error('测试运行未结束')
}
async function send(app: Awaited<ReturnType<typeof setup>>, changes: Partial<RunCommand> = {}) {
  const run = await app.ctx.ai.start(
    app.access,
    app.conversation.id,
    await command(app.ctx, app.access, app.conversation.id, changes),
  )
  return finish(app.ctx, app.access, run.id)
}
describe('AI 核心与实际 SQLite 数据库', () => {
  it('运行失败记录安全详情并通过 logger.error 输出上下文', async () => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate() {
          throw new AiError('provider_request_failed', 'HTTP 401：密钥无效')
        },
      },
    })
    const logged = vi.spyOn(app.ctx.logger, 'error')
    const failed = await send(app)
    expect(failed.error).toEqual({ code: 'provider_request_failed', message: 'HTTP 401：密钥无效' })
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('AI 运行失败'),
      failed.id,
      'provider',
      'model',
      'provider_request_failed: HTTP 401：密钥无效',
    )
    logged.mockRestore()

    const unknown = await setup({
      driver: {
        id: 'driver',
        async generate() {
          throw new Error('secret-never-export')
        },
      },
    })
    const result = await send(unknown)
    expect(result.error).toEqual({
      code: 'execution_failed',
      message: '运行失败，请检查服务端日志',
    })
  })
  it('历史按活动排序并在数据库分页，重命名与归档不改变活动时间', async () => {
    const app = await setup()
    await delay(2)
    const newer = await app.ctx.ai.createConversation(app.access, 'assistant', '第二个')
    expect((await app.ctx.ai.listConversations(app.access, 0, 1))[0]?.id).toBe(newer.id)
    await send(app)
    const [first] = await app.ctx.ai.listConversations(app.access, 0, 1)
    expect(first?.id).toBe(app.conversation.id)
    expect((await app.ctx.ai.listConversations(app.access, 1, 1))[0]?.id).toBe(newer.id)
    const renamed = await app.ctx.ai.updateConversation(app.access, app.conversation.id, {
      title: ' 新标题 ',
    })
    expect(renamed.title).toBe('新标题')
    expect(renamed.lastActivityAt).toBe(first?.lastActivityAt)
    await app.ctx.ai.updateConversation(app.access, app.conversation.id, { archived: true })
    expect(await app.ctx.ai.listConversations(app.access)).toHaveLength(1)
    expect((await app.ctx.ai.listConversations(app.access, 0, 50, true))[0]?.id).toBe(
      app.conversation.id,
    )
    await expect(send(app)).rejects.toMatchObject({ code: 'archived' })
    await app.ctx.ai.updateConversation(app.access, app.conversation.id, { archived: false })
    expect((await send(app)).status).toBe('completed')
  })
  it('会话元数据校验和跨空间拒绝访问', async () => {
    const app = await setup()
    for (const title of ['', '  ', '字'.repeat(201)])
      await expect(
        app.ctx.ai.updateConversation(app.access, app.conversation.id, { title }),
      ).rejects.toThrow()
    await expect(
      app.ctx.ai.updateConversation(app.other, app.conversation.id, { archived: true }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      app.ctx.ai.updateConversation(app.other, app.conversation.id, { title: '越界' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await app.ctx.ai.listConversations(app.other)).toEqual([])
  })
  it('生成中可重命名但不能归档，终态保留最新标题', async () => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(_r, _c, context) {
          await delay(10000, undefined, { signal: context.signal })
          return { content: [] }
        },
      },
    })
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    await expect(
      app.ctx.ai.updateConversation(app.access, app.conversation.id, { archived: true }),
    ).rejects.toMatchObject({ code: 'busy' })
    await Promise.all([
      app.ctx.ai.updateConversation(app.access, app.conversation.id, { title: '生成时的新标题' }),
      app.ctx.ai.cancel(app.access, run.id),
    ])
    const { conversation } = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(conversation.title).toBe('生成时的新标题')
    expect(conversation.activeRunId).toBeNull()
    expect(conversation.lastActivityAt).toBe((await app.ctx.ai.getRun(app.access, run.id)).endedAt)
  })
  it('旧历史回填取最新运行时间，重复回填不覆盖归档', async () => {
    const app = await setup()
    const run = await send(app)
    const db = app.ctx.database.scope<Tables>(app.ctx, '@antarestra/ai')
    const { conversation } = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    const { lastActivityAt: _activity, archivedAt: _archived, ...legacy } = conversation
    await db
      .updateTable('conversations')
      .set({ payload: JSON.stringify(legacy), last_activity_at: null })
      .where('id', '=', conversation.id)
      .execute()
    await app.ctx.ai.backfillHistory()
    expect((await app.ctx.ai.listConversations(app.access))[0]?.lastActivityAt).toBe(run.endedAt)
    const archived = await app.ctx.ai.updateConversation(app.access, conversation.id, {
      archived: true,
    })
    await app.ctx.ai.backfillHistory()
    expect((await app.ctx.ai.getConversation(app.access, conversation.id)).conversation).toEqual(
      archived,
    )
  })
  it('逐轮显式关闭推理不会继承 Agent 的默认强度', async () => {
    const app = await setup({ agent: agent({ defaultThinking: 'high' }) })
    const run = await send(app, { thinking: null })
    expect(run.status).toBe('completed')
    expect(run.thinking).toBeNull()
  })
  it('具名扩展准备通过 Cordis 分发，未选择的扩展不运行，卸载后拒绝运行', async () => {
    const app = await setup({ agent: agent({ extensions: { selected: { enabled: true } } }) })
    const sequence: string[] = []
    app.ctx.on('ai/prepare', () => {
      sequence.push('原生监听')
    })
    const remove = app.ctx.ai.registerExtension(app.ctx, {
      id: 'selected',
      schema: { type: 'object' },
      async prepare(_context, config) {
        expect(config.enabled).toBe(true)
        sequence.push('扩展准备')
      },
    })
    app.ctx.ai.registerExtension(app.ctx, {
      id: 'unused',
      schema: {},
      async prepare() {
        throw new Error('不应执行')
      },
    })
    expect((await send(app)).status).toBe('completed')
    expect(sequence).toEqual(['原生监听', '扩展准备'])
    await remove()
    await expect(send(app)).rejects.toMatchObject({ code: 'capability_unavailable' })
  })
  it('插件卸载清理事件和运行，核心恢复后消费者重新注册', async () => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(_request, _connection, context) {
          await delay(10000, undefined, { signal: context.signal })
          return { content: [] }
        },
      },
    })
    let registrations = 0
    const consumer = await app.ctx.plugin({
      inject: ['ai'],
      apply(ctx: Context) {
        registrations++
        ctx.ai.registerTool(ctx, {
          id: 'lifecycle',
          description: '',
          parameters: {},
          async execute() {
            return null
          },
        })
        ctx.on('ai/request', () => {})
      },
    })
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    await app.core.dispose()
    await app.ctx.plugin(ai, {})
    await consumer
    await app.backend
    // 依赖恢复后，执行后端应重新注册，不能只恢复其他消费者。
    expect(() => app.ctx.ai.registerBackend(app.ctx, agentCore.backend)).toThrow()
    const access = await app.ctx.ai.authorize('test', 'space')
    expect(registrations).toBe(2)
    expect((await app.ctx.ai.catalog(access)).tools.map((tool) => tool.id)).toEqual(['lifecycle'])
    expect((await app.ctx.ai.getRun(access, run.id)).status).not.toBe('running')
  })
  it('缺失后端不写入运行，参数校验失败不改变会话修订', async () => {
    const app = await setup({ agent: agent({ backendId: 'missing' }) })
    const request = await command(app.ctx, app.access, app.conversation.id)
    await expect(app.ctx.ai.start(app.access, app.conversation.id, request)).rejects.toMatchObject({
      code: 'capability_unavailable',
    })
    await expect(
      app.ctx.ai.start(app.access, app.conversation.id, {
        ...request,
        input: null,
      } as unknown as RunCommand),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation.revision,
    ).toBe(0)
  })
  it('独立卸载 pi 后端取消在途模型请求，重载后可以继续运行', async () => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let aborted = false
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(_request, _connection, context) {
          if (aborted) return { content: [{ type: 'text', text: '恢复完成' }] }
          entered()
          try {
            await delay(10000, undefined, { signal: context.signal })
          } finally {
            aborted = context.signal.aborted
          }
          return { content: [] }
        },
      },
    })
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    await ready
    await app.backend.dispose()
    expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('cancelled')
    await expect.poll(() => aborted).toBe(true)
    await expect(send(app)).rejects.toMatchObject({ code: 'capability_unavailable' })
    await app.ctx.plugin(agentCore)
    expect(
      (await send(app, { operation: 'regenerate', targetNodeId: run.userNodeId })).status,
    ).toBe('completed')
  })
  it('pi 工具适配不吞掉核心参数校验异常，也不开始下一次模型请求', async () => {
    let executed = false
    const app = await setup({
      agent: agent({ toolIds: ['strict'] }),
      driver: {
        id: 'driver',
        async generate() {
          return { content: [{ type: 'tool-call', id: 'bad', name: 'strict', arguments: {} }] }
        },
      },
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'strict',
      description: '',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      async execute() {
        executed = true
        return null
      },
    })
    const run = await send(app)
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('invalid_request')
    expect(run.requests).toHaveLength(1)
    expect(executed).toBe(false)
  })
  it('保存完整请求与历史，拒绝伪造上下文和跨空间访问，凭据不进入导出', async () => {
    const app = await setup()
    const run = await send(app)
    expect(run.status).toBe('completed')
    expect(run.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(run.requests[0]?.systemPrompt).toBe('系统')
    expect(JSON.stringify(run)).not.toContain('secret-never-export')
    expect(JSON.stringify(await app.ctx.ai.catalog(app.access))).not.toContain(
      'secret-never-export',
    )
    await expect(app.ctx.ai.getRun(app.other, run.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.ctx.ai.getConversation(app.other, app.conversation.id)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(app.ctx.ai.catalog({ ...app.access })).rejects.toMatchObject({ code: 'forbidden' })
  })
  it('重新生成、编辑用户消息和版本切换保持分支独立', async () => {
    const app = await setup()
    const first = await send(app)
    const second = await send(app, { operation: 'regenerate', targetNodeId: first.replyNodeId })
    expect(second.userNodeId).toBe(first.userNodeId)
    let view = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(view.nodes.filter((n) => n.role === 'assistant').map((n) => n.versionCount)).toEqual([
      2, 2,
    ])
    await app.ctx.ai.select(
      app.access,
      app.conversation.id,
      view.conversation.revision,
      second.replyNodeId,
      first.replyNodeId,
    )
    const next = await send(app, { input: { text: '沿第一版继续' } })
    expect(next.requests[0]?.messages).toHaveLength(3)
    const edit = await send(app, {
      operation: 'edit',
      targetNodeId: first.userNodeId,
      input: { text: '修改后的问题' },
    })
    expect(edit.requests[0]?.messages).toHaveLength(1)
    view = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(
      view.nodes.filter((n) => n.role === 'user' && n.parentId === null).map((n) => n.versionCount),
    ).toEqual([2, 2])
    expect(view.path.map((n) => n.id)).toEqual([edit.userNodeId, edit.replyNodeId])
  })
  it('同会话拒绝并发、重复请求幂等且旧修订冲突，取消保留增量', async () => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(_r, _c, context, update) {
          await update({ type: 'delta', kind: 'text', text: '部分内容' })
          await delay(10000, undefined, { signal: context.signal })
          return { content: [] }
        },
      },
    })
    const input = await command(app.ctx, app.access, app.conversation.id)
    const run = await app.ctx.ai.start(app.access, app.conversation.id, input)
    expect((await app.ctx.ai.start(app.access, app.conversation.id, input)).id).toBe(run.id)
    await expect(
      app.ctx.ai.start(app.access, app.conversation.id, { ...input, input: { text: '不同' } }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      app.ctx.ai.start(app.access, app.conversation.id, { ...input, idempotencyKey: 'other' }),
    ).rejects.toMatchObject({ code: 'busy' })
    for (let i = 0; i < 100; i++) {
      if ((await app.ctx.ai.events(app.access, run.id)).some((e) => e.type === 'message-delta'))
        break
      await delay(5)
    }
    await app.ctx.ai.cancel(app.access, run.id)
    expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('cancelled')
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).nodes.find(
        (n) => n.id === run.replyNodeId,
      )?.content,
    ).toContainEqual({ type: 'text', text: '部分内容' })
    await expect(
      app.ctx.ai.start(app.access, app.conversation.id, { ...input, idempotencyKey: 'stale' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(send(app)).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('工具覆盖栈精确回收，正在运行的工具绑定不随覆盖切换', async () => {
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const app = await setup({
      agent: agent({ toolIds: ['tool'] }),
      driver: {
        id: 'driver',
        async generate(request) {
          if (request.messages.at(-1)?.role === 'tool')
            return { content: [{ type: 'text', text: '完成' }] }
          await gate
          return { content: [{ type: 'tool-call', id: randomUUID(), name: 'tool', arguments: {} }] }
        },
      },
    })
    const tool = (value: string): Tool => ({
      id: 'tool',
      description: value,
      parameters: { type: 'object' },
      async execute() {
        return value
      },
    })
    const a = app.ctx.ai.registerTool(app.ctx, tool('A'))
    const b = app.ctx.ai.registerTool(app.ctx, tool('B'))
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    const c = app.ctx.ai.registerTool(app.ctx, tool('C'))
    await a()
    await a()
    expect((await app.ctx.ai.catalog(app.access)).tools[0]?.description).toBe('C')
    unblock()
    const result = await finish(app.ctx, app.access, run.id)
    expect(result.messages.find((m) => m.role === 'tool')?.content[0]).toMatchObject({
      content: 'B',
    })
    await c()
    expect((await app.ctx.ai.catalog(app.access)).tools[0]?.description).toBe('B')
    await b()
    expect((await app.ctx.ai.catalog(app.access)).tools).toHaveLength(0)
    expect(() => app.ctx.ai.registerTool(app.ctx, { ...tool('x'), id: 'use_skill' })).toThrow(
      '保留',
    )
  })
  it('绑定实现卸载取消 Run，后注册覆盖者不会受到旧回收影响', async () => {
    const app = await setup({
      agent: agent({ toolIds: ['tool'] }),
      driver: {
        id: 'driver',
        async generate(_r, _c, context) {
          await delay(10000, undefined, { signal: context.signal })
          return { content: [] }
        },
      },
    })
    const remove = app.ctx.ai.registerTool(app.ctx, {
      id: 'tool',
      description: '旧',
      parameters: {},
      async execute() {
        return null
      },
    })
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    app.ctx.ai.registerTool(app.ctx, {
      id: 'tool',
      description: '新',
      parameters: {},
      async execute() {
        return null
      },
    })
    await remove()
    expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('cancelled')
    expect((await app.ctx.ai.catalog(app.access)).tools[0]?.description).toBe('新')
  })
  it('Cordis 串行钩子支持 prepend 与卸载，通知失败不改变成功结果', async () => {
    const app = await setup()
    const sequence: string[] = []
    const extension = await app.ctx.plugin((ctx: Context) => {
      ctx.on('ai/request', (_context, draft) => {
        sequence.push('后')
        draft.systemPrompt += '后'
      })
      ctx.on(
        'ai/request',
        (_context, draft) => {
          sequence.push('前')
          draft.systemPrompt += '前'
          draft.thinking = 'high'
        },
        { prepend: true },
      )
      ctx.on('ai/event', async () => {
        throw new Error('通知失败')
      })
    })
    let result = await send(app)
    expect(result.status).toBe('completed')
    expect(result.requests[0]).toMatchObject({ systemPrompt: '系统前后', thinking: 'high' })
    expect(sequence).toEqual(['前', '后'])
    await extension.dispose()
    result = await send(app)
    expect(result.requests[0]?.systemPrompt).toBe('系统')
    app.ctx.on('ai/context', () => {
      throw new Error('转换失败')
    })
    result = await send(app)
    expect(result.status).toBe('failed')
  })
  it('并行执行同一工具，完成事件按完成顺序、上下文按调用顺序', async () => {
    let active = 0
    let max = 0
    const app = await setup({
      agent: agent({ toolIds: ['tool'] }),
      driver: {
        id: 'driver',
        async generate(request) {
          if (request.messages.at(-1)?.role === 'tool')
            return { content: [{ type: 'text', text: '完成' }] }
          return {
            content: [1, 2].map((n) => ({
              type: 'tool-call' as const,
              id: String(n),
              name: 'tool',
              arguments: { n },
            })),
          }
        },
      },
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'tool',
      description: '',
      parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      async execute(args) {
        active++
        max = Math.max(max, active)
        await delay(args.n === 1 ? 40 : 5)
        active--
        return args.n!
      },
    })
    const result = await send(app)
    expect(result.status).toBe('completed')
    expect(max).toBe(2)
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.content[0])).toMatchObject(
      [
        { id: '1', content: 1 },
        { id: '2', content: 2 },
      ],
    )
    const events = await app.ctx.ai.events(app.access, result.id)
    const ends = events.filter((e) => e.type === 'tool-end')
    expect(JSON.stringify(ends[0]?.data)).toContain('"id":"2"')
  })
  it('工具可覆盖默认超时，超时结果返回模型且继续运行', async () => {
    const app = await setup({
      config: { toolTimeoutMs: 5 },
      agent: agent({ toolIds: ['fast', 'long'] }),
      driver: {
        id: 'driver',
        async generate(request) {
          if (request.messages.at(-1)?.role === 'tool')
            return { content: [{ type: 'text', text: '完成' }] }
          return {
            content: ['fast', 'long'].map((name) => ({
              type: 'tool-call' as const,
              name,
              id: name,
              arguments: {},
            })),
          }
        },
      },
    })
    for (const id of ['fast', 'long'])
      app.ctx.ai.registerTool(app.ctx, {
        id,
        description: '',
        parameters: {},
        ...(id === 'long' ? { timeoutMs: 1000 } : {}),
        async execute(_args, context) {
          await delay(30, undefined, { signal: context.signal })
          return '完成'
        },
      })
    const result = await send(app)
    expect(result.status).toBe('completed')
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.content[0])).toMatchObject(
      [{ isError: true }, { isError: false }],
    )
  })
  it('模型活动续期且不设总时限，无活动超时与调用上限明确终止', async () => {
    const app = await setup({
      config: { modelIdleTimeoutMs: 40 },
      driver: {
        id: 'driver',
        async generate(_r, _c, _context, update) {
          for (let i = 0; i < 6; i++) {
            await delay(10)
            await update({ type: 'activity' })
          }
          return { content: [{ type: 'text', text: '完成' }] }
        },
      },
    })
    expect((await send(app)).status).toBe('completed')
    const silent = await setup({
      config: { modelIdleTimeoutMs: 10 },
      driver: {
        id: 'driver',
        async generate() {
          await delay(60)
          return { content: [] }
        },
      },
    })
    expect((await send(silent)).error?.code).toBe('model_idle_timeout')
    const limited = await setup({
      config: { maxModelCalls: 2 },
      agent: agent({ toolIds: ['tool'] }),
      driver: {
        id: 'driver',
        async generate() {
          return { content: [{ type: 'tool-call', id: randomUUID(), name: 'tool', arguments: {} }] }
        },
      },
    })
    limited.ctx.ai.registerTool(limited.ctx, {
      id: 'tool',
      description: '',
      parameters: {},
      async execute() {
        return null
      },
    })
    const result = await send(limited)
    expect(result.requests).toHaveLength(2)
    expect(result.error?.code).toBe('model_call_limit')
  })
  it('Skill 选择交给唯一服务，模板变量与新版 Agent 在下一轮生效', async () => {
    const app = await setup({
      agent: agent({ skillIds: null, userTemplate: '{{topic}}: {{input}}' }),
    })
    const selections: (string[] | null)[] = []
    app.ctx.ai.registerSkills(app.ctx, {
      async createTool(selection) {
        selections.push(selection)
        return {
          id: 'use_skill',
          description: '目录',
          parameters: {},
          async execute() {
            return null
          },
        }
      },
    })
    expect(() =>
      app.ctx.ai.registerSkills(app.ctx, {
        async createTool() {
          throw new Error()
        },
      }),
    ).toThrow('重复')
    const first = await send(app, { input: { text: '问题', variables: { topic: '主题' } } })
    expect(first.requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: '主题: 问题' }])
    expect(selections).toEqual([null])
    await app.removeAgent()
    app.ctx.ai.registerAgent(app.ctx, agent({ version: '2', skillIds: ['one'] }))
    expect((await send(app)).agent.version).toBe('2')
    expect((await app.ctx.ai.getRun(app.access, first.id)).agent.version).toBe('1')
    expect(selections).toEqual([null, ['one']])
  })
  it('缺失扩展和附件解析器、上下文超限均明确拒绝', async () => {
    const missing = await setup({ agent: agent({ extensions: { custom: {} } }) })
    await expect(send(missing)).rejects.toMatchObject({ code: 'capability_unavailable' })
    const app = await setup()
    const result = await send(app, {
      input: {
        text: '图片',
        attachments: [{ type: 'image', resourceId: 'image', mimeType: 'image/png' }],
      },
    })
    expect(result.error?.code).toBe('capability_unavailable')
    const large = await setup({ driver: { ...plain, estimateTokens: () => 20000 } })
    expect((await send(large)).error?.code).toBe('context_overflow')
  })
  it('数据库重开保存历史，并将遗留运行及事件恢复为中断', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-ai-'))
    directories.push(directory)
    const filename = join(directory, 'history.sqlite')
    const app = await setup({ filename })
    const completed = await send(app)
    // 模拟进程在运行事务落库后崩溃，重启不能自动执行任何工具。
    const db = app.ctx.database.scope<Tables>(app.ctx, '@antarestra/ai')
    await db
      .updateTable('runs')
      .set({
        status: 'running',
        payload: JSON.stringify({ ...completed, status: 'running', endedAt: null }),
      })
      .where('id', '=', completed.id)
      .execute()
    await app.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(app.ctx), 1)
    const reopened = await setup({ filename })
    const restored = await reopened.ctx.ai.getRun(reopened.access, completed.id)
    expect(restored.status).toBe('interrupted')
    expect(restored.messages).toEqual(completed.messages)
    expect((await reopened.ctx.ai.events(reopened.access, completed.id)).at(-1)?.type).toBe(
      'run-end',
    )
  })
  it('HTTP 鉴权、SSE 断线与 Last-Event-ID 重放', async () => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(_r, _c, _context, update) {
          await update({ type: 'delta', kind: 'text', text: '开始' })
          await delay(80)
          return { content: [{ type: 'text', text: '完成' }] }
        },
      },
    })
    await app.ctx.plugin(WebUI)
    await app.ctx.plugin(local, {
      providerId: 'local',
      bootstrapEmail: 'admin@example.com',
      bootstrapPassword: 'test-password-123',
    })
    const base = `http://127.0.0.1:${app.ctx.server.address!.port}/api`
    expect((await fetch(base + '/ai/catalog')).status).toBe(401)
    const login = await fetch(base + '/auth/local/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-password-123' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
    const created = await fetch(base + '/ai/conversations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'assistant' }),
    })
    expect(created.status).toBe(201)
    const conversation = (await created.json()) as { id: string }
    const started = await fetch(base + `/ai/conversations/${conversation.id}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operation: 'send',
        input: { text: '测试' },
        expectedRevision: 0,
        expectedNodeId: null,
        idempotencyKey: 'request',
      }),
    })
    expect(started.status).toBe(202)
    const run = (await started.json()) as { id: string }
    const stream = await fetch(base + `/ai/runs/${run.id}/events`, { headers })
    const reader = stream.body!.getReader()
    await reader.read()
    await reader.cancel()
    await delay(120)
    const replay = await fetch(base + `/ai/runs/${run.id}/events`, {
      headers: { ...headers, 'Last-Event-ID': '1' },
    })
    const text = await replay.text()
    expect(text).toContain('event: run-end')
    expect(text).not.toContain('\nid: 1\n')
    expect(text).not.toContain('secret-never-export')
    const final = await fetch(base + `/ai/runs/${run.id}`, { headers })
    expect(((await final.json()) as { status: string }).status).toBe('completed')
    const changed = await fetch(base + `/ai/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'HTTP 归档测试', archived: true }),
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      title: 'HTTP 归档测试',
      archivedAt: expect.any(Number),
    })
    expect(await (await fetch(base + '/ai/conversations', { headers })).json()).toEqual([])
    expect(
      await (await fetch(base + '/ai/conversations?archived=true', { headers })).json(),
    ).toMatchObject([{ id: conversation.id }])
    expect((await fetch(base + '/ai/conversations?archived=invalid', { headers })).status).toBe(400)
    expect(
      (
        await fetch(base + `/ai/conversations/${conversation.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ title: ' ' }),
        })
      ).status,
    ).toBe(400)
  })
})
