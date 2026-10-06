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
import * as basicTools from '@antarestra/plugin-basic-tools'
import type { Access, AgentPreset, Config, ModelDriver, RunCommand, Tool } from '@antarestra/ai'
import type { Tables } from '../../plugins/definitions/ai/src/store.js'
import type { ConversationStateEvent } from '@antarestra/contracts'
import { readEvents } from '../../plugins/features/chat-webui/client/stream.js'

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
  contextPolicy: {
    compaction: { enabled: true, reserve: 1000, keepRecent: 1000, model: null, thinking: null },
    trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
  },
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
    imageInput?: boolean
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
        input: options.imageInput === false ? ['text'] : ['text', 'image', 'file'],
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
  it('直接调用已有模型，无 Agent 后端也能传递提示词、上下文和思考强度，不增加运行记录', async () => {
    const generate = vi.fn<ModelDriver['generate']>(async () => ({
      content: [{ type: 'text', text: '译文' }],
      stopReason: 'stop',
    }))
    const app = await setup({ driver: { id: 'driver', generate } })
    await app.backend.dispose()
    await app.removeAgent()
    const before = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    const result = await app.ctx.ai.generate(app.ctx, app.access, {
      model,
      systemPrompt: '自定义提示词 {{不展开}}',
      thinking: 'high',
      maxOutputTokens: 80,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '上下文' }] },
        { role: 'user', content: [{ type: 'text', text: '待翻译' }] },
      ],
    })
    expect(result.content).toEqual([{ type: 'text', text: '译文' }])
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]![0]).toMatchObject({
      tools: [],
      systemPrompt: '自定义提示词 {{不展开}}',
      thinking: 'high',
      maxOutputTokens: 80,
    })
    expect(generate.mock.calls[0]![1].credential).toBe('secret-never-export')
    expect(generate.mock.calls[0]![2]).toMatchObject({ actorId: 'actor', workspaceId: 'space' })
    expect(generate.mock.calls[0]![2]).not.toHaveProperty('agent')
    expect(await app.ctx.ai.getConversation(app.access, app.conversation.id)).toEqual(before)
    await expect(
      app.ctx.ai.generate(
        app.ctx,
        { actorId: 'actor', workspaceId: 'other' },
        { model, systemPrompt: '', messages: [] },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      app.ctx.ai.generate(app.ctx, app.access, {
        model,
        systemPrompt: '',
        messages: [],
        thinking: 'unknown',
      }),
    ).rejects.toThrow('思考强度')
  })
  it.each(['owner', 'provider', 'driver', 'core', 'signal'] as const)(
    '直接调用在 %s 取消或卸载时终止',
    async (kind) => {
      let signal: AbortSignal | undefined
      const app = await setup({
        driver: {
          id: 'driver',
          generate: async (_request, _connection, context) => {
            signal = context.signal
            return new Promise(() => {})
          },
        },
      })
      let owner!: Context
      const fiber = await app.ctx.plugin((ctx: Context) => {
        owner = ctx
      })
      const provider = app.ctx.ai.registerProvider(owner, {
        id: 'direct',
        title: '直接调用',
        driverId: 'direct-driver',
        baseUrl: '',
        models: app.ctx.ai.capabilities().providers[0]!.models,
      })
      const driver = app.ctx.ai.registerDriver(owner, {
        id: 'direct-driver',
        generate: async (_request, _connection, context) => {
          signal = context.signal
          return new Promise(() => {})
        },
      })
      const controller = new AbortController()
      const pending = app.ctx.ai.generate(owner, app.access, {
        model: { providerId: 'direct', modelId: 'model' },
        systemPrompt: '',
        messages: [],
        signal: controller.signal,
      })
      const failure = expect(pending).rejects.toBeDefined()
      await vi.waitFor(() => expect(signal).toBeDefined())
      if (kind === 'owner') await fiber.dispose()
      else if (kind === 'provider') await provider()
      else if (kind === 'driver') await driver()
      else if (kind === 'core') await app.core.dispose()
      else controller.abort()
      await failure
      expect(signal!.aborted).toBe(true)
    },
  )
  it('直接调用结束时重新检查可信空间，不返回身份已变化的结果', async () => {
    let finish!: () => void
    const app = await setup({
      driver: {
        id: 'driver',
        generate: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve
          })
          return { content: [{ type: 'text', text: '结果' }] }
        },
      },
    })
    let workspaceId = 'space'
    app.ctx.rbac.registerRequestSource(app.ctx, 'direct-test', {
      id: 'direct-test',
      resolve: async () => ({ actorId: 'actor', workspaceId, roles: ['user'] }),
    })
    const access = await app.ctx.ai.authorize('direct-test', {})
    const pending = app.ctx.ai.generate(app.ctx, access, { model, systemPrompt: '', messages: [] })
    const failure = expect(pending).rejects.toMatchObject({ code: 'forbidden' })
    await vi.waitFor(() => expect(finish).toBeDefined())
    workspaceId = 'other'
    finish()
    await failure
  })
  it('直接调用拒绝截断、工具输出和空闲超时', async () => {
    const generate = vi.fn<ModelDriver['generate']>()
    const app = await setup({
      config: { modelIdleTimeoutMs: 20 },
      driver: { id: 'driver', generate },
    })
    const request = { model, systemPrompt: '', messages: [] }
    generate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '未完成' }],
      stopReason: 'length',
    })
    await expect(app.ctx.ai.generate(app.ctx, app.access, request)).rejects.toMatchObject({
      code: 'model_output_truncated',
    })
    generate.mockResolvedValueOnce({
      content: [{ type: 'tool-call', id: 'call', name: 'forbidden', arguments: {} }],
    })
    await expect(app.ctx.ai.generate(app.ctx, app.access, request)).rejects.toThrow('非文本')
    generate.mockImplementationOnce(async () => new Promise(() => {}))
    await expect(app.ctx.ai.generate(app.ctx, app.access, request)).rejects.toMatchObject({
      code: 'model_idle_timeout',
    })
  })
  it.each([false, true])(
    '截断保留内容和结束原因，不执行工具或自动续写（工具=%s）',
    async (withTool) => {
      const directory = await mkdtemp(join(tmpdir(), 'antarestra-truncated-'))
      directories.push(directory)
      const filename = join(directory, 'history.sqlite')
      const execute = vi.fn(async () => null)
      const app = await setup({
        filename,
        agent: agent({ toolIds: ['tool'] }),
        driver: {
          id: 'driver',
          async generate(_request, _connection, _context, update) {
            await update({ type: 'delta', kind: 'text', text: '未完成的回答' })
            return {
              stopReason: 'length',
              content: [
                { type: 'text', text: '未完成的回答' },
                ...(withTool
                  ? [{ type: 'tool-call' as const, id: 'partial', name: 'tool', arguments: {} }]
                  : []),
              ],
            }
          },
        },
      })
      app.ctx.ai.registerTool(app.ctx, {
        id: 'tool',
        description: '',
        parameters: {},
        execute,
      })
      const run = await send(app)
      expect(run.status).toBe('failed')
      expect(run.error).toEqual({
        code: 'model_output_truncated',
        message: '模型达到输出上限，回复未完整生成，请重试',
      })
      expect(run.messages.at(-1)).toMatchObject({
        role: 'assistant',
        stopReason: 'length',
        content: expect.arrayContaining([{ type: 'text', text: '未完成的回答' }]),
      })
      expect(run.requests).toHaveLength(1)
      expect(execute).not.toHaveBeenCalled()
      const events = await app.ctx.ai.events(app.access, run.id)
      expect(events.at(-1)).toMatchObject({
        type: 'run-end',
        data: { status: 'failed', error: run.error },
      })
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'message',
          data: expect.objectContaining({ stopReason: 'length' }),
        }),
      )
      await app.ctx.fiber.dispose()
      contexts.splice(contexts.indexOf(app.ctx), 1)
      const reopened = await setup({ filename })
      expect(await reopened.ctx.ai.getRun(reopened.access, run.id)).toEqual(run)
      expect(await reopened.ctx.ai.events(reopened.access, run.id)).toEqual(events)
      const history = await reopened.ctx.ai.getConversation(reopened.access, run.conversationId)
      expect(history.path.at(-1)?.content).toContainEqual({ type: 'text', text: '未完成的回答' })
    },
  )
  it.each(['error', 'aborted', 'pending', 'deferred'] as const)(
    '模型返回非完整结束原因 %s 时不报告成功',
    async (stopReason) => {
      const app = await setup({
        driver: {
          id: 'driver',
          async generate() {
            return { content: [], stopReason }
          },
        },
      })
      const run = await send(app)
      expect(run.status).toBe('failed')
      expect(run.error?.code).toBe('model_output_incomplete')
      expect(run.messages.at(-1)?.stopReason).toBe(stopReason)
    },
  )
  it.each(['stop', undefined] as const)('完整回复兼容结束原因 %s', async (stopReason) => {
    const app = await setup({
      driver: {
        id: 'driver',
        async generate() {
          return {
            content: [{ type: 'text', text: '完整回答' }],
            ...(stopReason ? { stopReason } : {}),
          }
        },
      },
    })
    const run = await send(app)
    expect(run.status).toBe('completed')
    expect(run.error).toBeNull()
    expect(run.messages.at(-1)?.stopReason).toBe(stopReason)
  })
  it.each([
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ])('工具图像传给模型且历史只保存引用（视觉=%s，保存=%s）', async (imageInput, persist) => {
    let calls = 0
    let stored = {
      type: 'image' as const,
      resourceId: 'generated',
      mimeType: 'image/png',
      filename: '截图.png',
      size: 3,
      width: 1,
      height: 1,
    }
    const app = await setup({
      imageInput,
      agent: agent({
        toolIds: ['plain', 'image'],
        contextPolicy: {
          compaction: {
            enabled: false,
            reserve: 1000,
            keepRecent: 1000,
            model: null,
            thinking: null,
          },
          trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
        },
      }),
      driver: {
        id: 'driver',
        async generate(request, connection) {
          if (calls++ === 0)
            return {
              stopReason: 'toolUse',
              content: [
                { type: 'tool-call', id: 'plain', name: 'plain', arguments: {} },
                { type: 'tool-call', id: 'image', name: 'image', arguments: {} },
              ],
            }
          expect(connection.resources?.get(stored.resourceId)?.data).toBe(
            imageInput && (persist || calls === 2) ? 'YWJj' : undefined,
          )
          const results = request.messages
            .flatMap((message) => message.content)
            .filter((block) => block.type === 'tool-result')
          expect(results.find((block) => block.id === 'plain')?.content).toEqual({
            content: '普通 JSON',
            images: [],
          })
          expect(results.find((block) => block.id === 'image')).toMatchObject({
            content: { ok: true },
            images: [stored],
          })
          return { content: [{ type: 'text', text: '已查看' }] }
        },
      },
    })
    const resolver = vi.fn(async () => ({
      data: 'YWJj',
      mimeType: 'image/png',
      filename: '截图.png',
    }))
    if (persist)
      app.ctx.ai.registerResources(app.ctx, {
        validate: async () => {},
        resolve: resolver,
        storeImage: async () => stored,
      })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'plain',
      description: '',
      parameters: { type: 'object' },
      execute: async () => ({ content: '普通 JSON', images: [] }),
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'image',
      description: '',
      resultMode: 'structured',
      parameters: { type: 'object' },
      execute: async (_args, context) => {
        await expect(
          app.ctx.ai.storeToolImage(
            { ...context },
            {
              data: Buffer.from('abc'),
              mimeType: 'image/png',
              filename: '截图.png',
              width: 1,
              height: 1,
            },
          ),
        ).rejects.toMatchObject({ code: 'forbidden' })
        const image = await app.ctx.ai.storeToolImage(
          context,
          {
            data: Buffer.from('abc'),
            mimeType: 'image/png',
            filename: '截图.png',
            width: 1,
            height: 1,
          },
          persist,
        )
        stored = image
        return { content: { ok: true }, images: [image] }
      },
    })
    const run = await send(app)
    expect(run.status).toBe('completed')
    expect(JSON.stringify(run)).not.toContain('YWJj')
    expect(resolver.mock.calls.length > 0).toBe(imageInput && persist)
    if (!persist) {
      expect(stored.resourceId).toMatch(/^ai-transient:/)
      expect((await send(app)).status).toBe('completed')
    }
  })
  it('工具读取资源使用真实上下文及运行固定的解析器，拒绝伪造上下文', async () => {
    let calls = 0
    const app = await setup({
      agent: agent({ toolIds: ['read_html'] }),
      driver: {
        id: 'driver',
        async generate() {
          if (calls++ === 0)
            return {
              stopReason: 'toolUse',
              content: [{ type: 'tool-call', id: 'read', name: 'read_html', arguments: {} }],
            }
          return { content: [{ type: 'text', text: '已读取' }] }
        },
      },
    })
    const resolve = vi.fn(async (resource, context) => {
      expect(resource.resourceId).toBe('html-file')
      expect(context.workspaceId).toBe(app.access.workspaceId)
      return {
        data: Buffer.from('<h1>文档</h1>').toString('base64'),
        mimeType: 'text/html',
        filename: '文档.html',
      }
    })
    app.ctx.ai.registerResources(app.ctx, { validate: async () => {}, resolve })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'read_html',
      description: '',
      parameters: { type: 'object' },
      async execute(_args, context) {
        await expect(
          app.ctx.ai.readToolResource({ ...context, workspaceId: 'other' }, 'html-file'),
        ).rejects.toMatchObject({ code: 'forbidden' })
        const resource = await app.ctx.ai.readToolResource(context, 'html-file')
        expect(resource.mimeType).toBe('text/html')
        return { ok: true }
      },
    })
    expect((await send(app)).status).toBe('completed')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('主模型失败后的重新生成复用已提交摘要，重复幂等键不重复压缩', async () => {
    let compressed = 0
    let failReply = false
    const app = await setup({
      driver: {
        id: 'driver',
        async generate(request) {
          if (request.purpose === 'compaction') {
            compressed++
            return { content: [{ type: 'text', text: '可复用摘要' }], stopReason: 'stop' }
          }
          if (failReply) throw new AiError('provider_request_failed', '模拟主模型失败')
          return { content: [{ type: 'text', text: '回答' }] }
        },
      },
    })
    for (let i = 0; i < 3; i++) await send(app, { input: { text: '甲'.repeat(1800) } })
    failReply = true
    const failed = await send(app, { input: { text: '甲'.repeat(1800) } })
    expect(failed.status).toBe('failed')
    expect(compressed).toBe(1)
    failReply = false
    const retry = await command(app.ctx, app.access, app.conversation.id, {
      operation: 'regenerate',
      targetNodeId: failed.replyNodeId,
    })
    const first = await app.ctx.ai.start(app.access, app.conversation.id, retry)
    const repeated = await app.ctx.ai.start(app.access, app.conversation.id, retry)
    expect(repeated.id).toBe(first.id)
    const completed = await finish(app.ctx, app.access, first.id)
    expect(completed.status).toBe('completed')
    expect(compressed).toBe(1)
    expect(completed.requests[0]?.purpose).toBe('reply')
  })
  it('长工具轮次在安全边界压缩，工具返回后预算仍会重新检查', async () => {
    let calls = 0
    const preset = agent({ toolIds: ['large'] })
    const app = await setup({
      agent: preset,
      driver: {
        id: 'driver',
        async generate(request) {
          if (request.purpose === 'compaction')
            return {
              content: [{ type: 'text', text: '先前工具已经成功返回。' }],
              stopReason: 'stop',
            }
          if (++calls <= 4)
            return {
              content: [{ type: 'tool-call', id: `large-${calls}`, name: 'large', arguments: {} }],
            }
          return { content: [{ type: 'text', text: '完成工具任务' }] }
        },
      },
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'large',
      description: '大结果',
      parameters: { type: 'object' },
      execute: async () => '甲'.repeat(1800),
    })
    const result = await send(app)
    expect(result.status).toBe('completed')
    expect(
      result.contextOperations?.some((op) => op.kind === 'compact' && op.status === 'completed'),
    ).toBe(true)
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(4)
    expect(
      result.requests
        .at(-1)
        ?.messages.some((message) => message.id === `user:${result.userNodeId}`),
    ).toBe(true)
    expect(result.contextBudgets?.filter((entry) => entry.phase === 'after')).toHaveLength(5)
  })
  it('摘要事务持久化，重启续聊复用且不改聊天原文，跨空间不能访问', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-context-'))
    directories.push(directory)
    const filename = join(directory, 'context.sqlite')
    const summarize = vi.fn()
    const driver: ModelDriver = {
      id: 'driver',
      async generate(request) {
        if (request.purpose === 'compaction') {
          summarize(request)
          return {
            content: [{ type: 'text', text: '已确认目标：保留上下文功能。' }],
            stopReason: 'stop',
            usage: { input: 100, output: 20, cacheRead: 30 },
          }
        }
        return { content: [{ type: 'text', text: '回答' }] }
      },
    }
    const app = await setup({ filename, driver })
    for (let i = 0; i < 4; i++)
      expect((await send(app, { input: { text: `${i}：${'甲'.repeat(1800)}` } })).status).toBe(
        'completed',
      )
    expect(summarize).toHaveBeenCalledOnce()
    const last = (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation
      .selectedNodeId
    const db = app.ctx.database.scope<Tables>(app.ctx, '@antarestra/ai')
    const saved = await db.selectFrom('summaries').selectAll().execute()
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]!.payload)).toMatchObject({
      workspaceId: 'space',
      text: '已确认目标：保留上下文功能。',
    })
    const history = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(history.path.filter((node) => node.role === 'user')).toHaveLength(4)
    expect(history.path[0]?.content[0]).toMatchObject({ text: `0：${'甲'.repeat(1800)}` })
    await app.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(app.ctx), 1)
    const next = await setup({ filename, driver })
    const resumed = { ...next, conversation: app.conversation }
    const run = await send(resumed, { input: { text: '继续' } })
    expect(run.status).toBe('completed')
    expect(summarize).toHaveBeenCalledOnce()
    expect(JSON.stringify(run.requests[0]?.messages)).toContain('已确认目标')
    expect(JSON.stringify(run.requests[0]?.messages)).not.toContain(`0：${'甲'.repeat(1800)}`)
    await expect(next.ctx.ai.getRun(next.other, run.id)).rejects.toMatchObject({ status: 404 })
    // 回到摘要覆盖范围之前进行编辑，新分支不能使用未来摘要。
    const edited = await send(resumed, {
      operation: 'edit',
      targetNodeId: history.path[0]!.id,
      input: { text: '新的任务' },
    })
    expect(edited.status).toBe('completed')
    expect(JSON.stringify(edited.requests[0]?.messages)).not.toContain('已确认目标')
    expect(last).not.toBeNull()
    await next.ctx.ai.updateConversation(next.access, app.conversation.id, { archived: true })
    await next.ctx.ai.deleteConversation(next.access, app.conversation.id)
    expect(
      await next.ctx.database
        .scope<Tables>(next.ctx, '@antarestra/ai')
        .selectFrom('summaries')
        .selectAll()
        .execute(),
    ).toEqual([])
  })
  it('压缩可使用聊天列表外的独立模型，窗口不足分批且主请求输出不受预留限制', async () => {
    const preset = agent()
    preset.contextPolicy!.compaction.model = { providerId: 'summary', modelId: 'small' }
    const app = await setup({ agent: preset })
    const compressed = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '分批历史摘要' }],
      stopReason: 'stop' as const,
    }))
    app.ctx.ai.registerProvider(app.ctx, {
      id: 'summary',
      title: '压缩专用',
      baseUrl: 'https://example.invalid',
      driverId: 'summary-driver',
      models: [
        {
          id: 'small',
          title: '小窗口',
          contextWindow: 2000,
          maxOutputTokens: 400,
          thinkingLevels: [],
          input: ['text'],
          output: ['text'],
          tools: false,
        },
      ],
    })
    app.ctx.ai.registerDriver(app.ctx, { id: 'summary-driver', generate: compressed })
    for (let i = 0; i < 4; i++) {
      const run = await send(app, { input: { text: '甲'.repeat(1800) } })
      expect(run.status).toBe('completed')
      expect(run.requests.at(-1)?.model).toEqual(model)
      expect(run.requests.at(-1)?.maxOutputTokens).toBeUndefined()
    }
    expect(compressed.mock.calls.length).toBeGreaterThan(1)
    expect(
      (await app.ctx.ai.catalog(app.access)).agents.find((item) => item.id === 'assistant')?.models,
    ).not.toContainEqual({ providerId: 'summary', modelId: 'small' })
  })
  it.each(['length', 'empty', 'cancel'] as const)(
    '压缩异常 %s 保留历史且不提交摘要',
    async (failure) => {
      let began!: () => void
      const started = new Promise<void>((resolve) => {
        began = resolve
      })
      const app = await setup({
        driver: {
          id: 'driver',
          async generate(request, _connection, context) {
            if (request.purpose !== 'compaction')
              return { content: [{ type: 'text', text: '回答' }] }
            began()
            if (failure === 'cancel')
              await new Promise<void>((resolve) =>
                context.signal.addEventListener('abort', () => resolve(), { once: true }),
              )
            return {
              content: [{ type: 'text', text: failure === 'empty' ? '' : '未完整摘要' }],
              stopReason: failure === 'length' ? 'length' : 'stop',
            }
          },
        },
      })
      for (let i = 0; i < 3; i++)
        expect((await send(app, { input: { text: '甲'.repeat(1800) } })).status).toBe('completed')
      const promise = send(app, { input: { text: '甲'.repeat(1800) } })
      await started
      if (failure === 'cancel') {
        const id = (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation
          .activeRunId!
        await app.ctx.ai.cancel(app.access, id)
      }
      const run = await promise
      expect(run.status).toBe(failure === 'cancel' ? 'cancelled' : 'failed')
      expect(run.contextOperations?.at(-1)?.status).toBe(
        failure === 'cancel' ? 'cancelled' : 'failed',
      )
      expect(
        await app.ctx.database
          .scope<Tables>(app.ctx, '@antarestra/ai')
          .selectFrom('summaries')
          .selectAll()
          .execute(),
      ).toEqual([])
      expect(
        (await app.ctx.ai.getConversation(app.access, app.conversation.id)).path.filter(
          (node) => node.role === 'user',
        ),
      ).toHaveLength(4)
    },
  )
  it('仅允许删除本空间已归档对话，并永久清除消息、运行与事件', async () => {
    const app = await setup()
    const { ctx, access, other, conversation } = app
    await expect(ctx.ai.deleteConversation(access, conversation.id)).rejects.toMatchObject({
      code: 'not_archived',
      status: 409,
    })
    const run = await send(app)
    const preserved = await ctx.ai.createConversation(access, 'assistant', '保留')
    await ctx.ai.updateConversation(access, conversation.id, { archived: true })
    await expect(ctx.ai.deleteConversation(other, conversation.id)).rejects.toMatchObject({
      status: 404,
    })
    const db = ctx.database.scope<Tables>(ctx, '@antarestra/ai')
    expect(
      await db.selectFrom('events').selectAll().where('run_id', '=', run.id).execute(),
    ).not.toHaveLength(0)
    const listener = vi.fn()
    ctx.on('ai/conversation', listener)
    await ctx.ai.deleteConversation(access, conversation.id)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: conversation.id }), true)
    for (const table of ['conversations', 'nodes', 'runs'] as const)
      expect(
        await db
          .selectFrom(table)
          .selectAll()
          .where('conversation_id', '=', conversation.id)
          .execute(),
      ).toEqual([])
    expect(
      await db.selectFrom('events').selectAll().where('run_id', '=', run.id).execute(),
    ).toEqual([])
    await expect(ctx.ai.getConversation(access, conversation.id)).rejects.toMatchObject({
      status: 404,
    })
    await expect(ctx.ai.getRun(access, run.id)).rejects.toMatchObject({ status: 404 })
    await expect(ctx.ai.deleteConversation(access, conversation.id)).rejects.toMatchObject({
      status: 404,
    })
    expect((await ctx.ai.getConversation(access, preserved.id)).conversation.id).toBe(preserved.id)
  })
  it('基本工具列表通过 SQLite 文件跨服务重启保留，卸载取消运行并回收工具', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-todos-'))
    directories.push(directory)
    const filename = join(directory, 'todos.sqlite')
    let generated = false
    const app = await setup({
      filename,
      agent: agent({ toolIds: ['todo'] }),
      driver: {
        id: 'driver',
        async generate() {
          if (generated) return { content: [{ type: 'text', text: '保留计划' }] }
          generated = true
          return {
            content: [
              {
                type: 'tool-call',
                id: 'set',
                name: 'todo',
                arguments: {
                  action: 'set',
                  items: [{ id: 'a', text: '未完成任务', status: 'pending' }],
                },
              },
            ],
          }
        },
      },
    })
    await app.ctx.plugin(basicTools)
    await send(app)
    const id = app.conversation.id
    await app.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(app.ctx), 1)
    const next = await setup({
      filename,
      agent: agent({ toolIds: ['todo'] }),
      driver: {
        id: 'driver',
        async generate(_request, _connection, context) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { content: [] }
        },
      },
    })
    const plugin = await next.ctx.plugin(basicTools)
    expect((await next.ctx.ai.getConversation(next.access, id)).conversation.todos).toEqual([
      { id: 'a', text: '未完成任务', status: 'pending' },
    ])
    const run = await next.ctx.ai.start(next.access, id, await command(next.ctx, next.access, id))
    await plugin.dispose()
    expect((await next.ctx.ai.getRun(next.access, run.id)).status).toBe('cancelled')
    expect(
      (await next.ctx.ai.getConversation(next.access, id)).conversation.todos?.[0]?.status,
    ).toBe('pending')
    expect(next.ctx.ai.capabilities().tools).toEqual([])
    const restored = await next.ctx.plugin(basicTools)
    expect(next.ctx.ai.capabilities().tools.map((tool) => tool.id)).toEqual([
      'get_datetime',
      'rename_conversation',
      'todo',
    ])
    await restored.dispose()
  })
  it('日期时间工具通过核心执行并返回查询结果或参数错误', async () => {
    let called = false
    const app = await setup({
      agent: agent({ toolIds: ['get_datetime'] }),
      driver: {
        id: 'driver',
        async generate() {
          if (called) return { content: [{ type: 'text', text: '查询完成' }] }
          called = true
          return {
            content: [
              {
                type: 'tool-call',
                id: 'valid',
                name: 'get_datetime',
                arguments: { datetime: '2026-10-03T12:30:00+08:00', timeZone: 'UTC' },
              },
              {
                type: 'tool-call',
                id: 'invalid',
                name: 'get_datetime',
                arguments: { datetime: '2026-02-30' },
              },
            ],
          }
        },
      },
    })
    await app.ctx.plugin(basicTools)
    const run = await send(app)
    expect(run.status).toBe('completed')
    const results = run.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool-result')
    expect(results.find((block) => block.id === 'valid')).toMatchObject({
      isError: false,
      content: { utcDateTime: '2026-10-03T04:30:00.000Z', utcOffset: '+00:00' },
    })
    expect(results.find((block) => block.id === 'invalid')).toMatchObject({ isError: true })
  })
  it('基本工具原子更新标题和待办，支持跨轮次、并发单项更新与全部完成', async () => {
    let calls: Extract<import('@antarestra/ai').ContentBlock, { type: 'tool-call' }>[] = []
    const app = await setup({
      agent: agent({ toolIds: ['rename_conversation', 'todo'] }),
      driver: {
        id: 'driver',
        async generate() {
          if (calls.length) {
            const content = calls
            calls = []
            return { content }
          }
          return { content: [{ type: 'text', text: '完成' }] }
        },
      },
    })
    const plugin = await app.ctx.plugin(basicTools)
    const todo = (id: string, arguments_: import('@antarestra/ai').JsonObject) => ({
      type: 'tool-call' as const,
      id,
      name: 'todo',
      arguments: arguments_,
    })
    calls = [
      {
        type: 'tool-call',
        id: 'title',
        name: 'rename_conversation',
        arguments: { title: '项目计划' },
      },
      todo('create', {
        action: 'set',
        items: [
          { id: 'research', text: '调查需求', status: 'in_progress' },
          { id: 'implement', text: '实现功能', status: 'pending' },
        ],
      }),
    ]
    expect((await send(app)).status).toBe('completed')
    const created = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(created.conversation).toMatchObject({
      title: '项目计划',
      todos: [
        { id: 'research', status: 'in_progress' },
        { id: 'implement', status: 'pending' },
      ],
    })
    await expect(app.ctx.ai.getConversation(app.other, app.conversation.id)).rejects.toMatchObject({
      status: 404,
    })
    calls = [
      todo('one', { action: 'update', id: 'research', status: 'completed' }),
      todo('two', { action: 'update', id: 'implement', status: 'in_progress' }),
    ]
    await send(app)
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation.todos?.map(
        (item) => item.status,
      ),
    ).toEqual(['completed', 'in_progress'])
    const unrelated = await app.ctx.ai.createConversation(app.access, 'assistant', '另一对话')
    calls = [todo('all', { action: 'complete_all' })]
    await send(app)
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation.todos?.every(
        (item) => item.status === 'completed',
      ),
    ).toBe(true)
    expect(
      (await app.ctx.ai.getConversation(app.access, unrelated.id)).conversation.todos,
    ).toBeUndefined()
    await plugin.dispose()
    expect(app.ctx.ai.capabilities().tools).toEqual([])
  })
  it('基本工具拒绝重复标识、未知待办项和空白标题，保留已有列表', async () => {
    let calls: Extract<import('@antarestra/ai').ContentBlock, { type: 'tool-call' }>[] = []
    const app = await setup({
      agent: agent({ toolIds: ['todo', 'rename_conversation'] }),
      driver: {
        id: 'driver',
        async generate() {
          const content = calls.length ? calls : [{ type: 'text' as const, text: '结束' }]
          calls = []
          return { content }
        },
      },
    })
    await app.ctx.plugin(basicTools)
    calls = [
      {
        type: 'tool-call',
        id: 'set',
        name: 'todo',
        arguments: {
          action: 'set',
          items: [{ id: 'a', text: '任务', status: 'pending' }],
        },
      },
    ]
    await send(app)
    calls = [
      {
        type: 'tool-call',
        id: 'duplicate',
        name: 'todo',
        arguments: {
          action: 'set',
          items: [
            { id: 'a', text: '新任务', status: 'pending' },
            { id: 'a', text: '重复', status: 'pending' },
          ],
        },
      },
      {
        type: 'tool-call',
        id: 'unknown',
        name: 'todo',
        arguments: { action: 'update', id: 'missing', status: 'completed' },
      },
      { type: 'tool-call', id: 'blank', name: 'rename_conversation', arguments: { title: '   ' } },
    ]
    const run = await send(app)
    expect(
      run.messages
        .filter((message) => message.role === 'tool')
        .flatMap((message) => message.content)
        .every((block) => block.type === 'tool-result' && block.isError),
    ).toBe(true)
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation.todos,
    ).toEqual([{ id: 'a', text: '任务', status: 'pending' }])
  })
  it('会话工具更新拒绝伪造、跨空间及执行完成后的上下文', async () => {
    let captured: import('@antarestra/ai').RunContext | undefined
    let called = false
    const app = await setup({
      agent: agent({ toolIds: ['probe'] }),
      driver: {
        id: 'driver',
        async generate() {
          if (called) return { content: [{ type: 'text', text: '结束' }] }
          called = true
          return { content: [{ type: 'tool-call', id: 'probe', name: 'probe', arguments: {} }] }
        },
      },
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'probe',
      description: '测试上下文',
      parameters: { type: 'object' },
      async execute(_args, context) {
        captured = context
        await expect(
          app.ctx.ai.updateRunConversation({ ...context }, () => ({ title: '伪造' })),
        ).rejects.toMatchObject({ status: 403 })
        await expect(
          app.ctx.ai.updateRunConversation({ ...context, workspaceId: 'other' }, () => ({
            title: '越界',
          })),
        ).rejects.toMatchObject({ status: 403 })
        await app.ctx.ai.updateRunConversation(context, () => ({ title: '合法工具' }))
        return null
      },
    })
    await send(app)
    expect(
      (await app.ctx.ai.getConversation(app.access, app.conversation.id)).conversation.title,
    ).toBe('合法工具')
    await expect(
      app.ctx.ai.updateRunConversation(captured!, () => ({ title: '过期' })),
    ).rejects.toMatchObject({ status: 403 })
  })
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
    expect(run.messages.at(-1)?.content).toEqual([
      { type: 'tool-call', id: 'bad', name: 'strict', arguments: {} },
    ])
    expect(
      (await app.ctx.ai.events(app.access, run.id)).some(
        (event) => event.type === 'message' && JSON.stringify(event.data).includes('strict'),
      ),
    ).toBe(true)
  })
  it('未提供的工具调用被拒绝执行，但名称与参数仍保存在事件和回复节点中', async () => {
    const call = {
      type: 'tool-call' as const,
      id: 'unknown',
      name: 'rename_conversation',
      arguments: { title: '晚餐建议' },
    }
    const app = await setup({
      driver: {
        id: 'driver',
        async generate() {
          return { content: [call] }
        },
      },
    })
    const run = await send(app)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toBe('模型调用了未提供的工具')
    expect(run.messages.at(-1)?.content).toEqual([call])
    const events = await app.ctx.ai.events(app.access, run.id)
    expect(
      events.find(
        (event) =>
          event.type === 'message' && JSON.stringify(event.data).includes('rename_conversation'),
      )?.data,
    ).toMatchObject({ content: [call] })
    expect(events.some((event) => event.type === 'tool-start')).toBe(false)
    const conversation = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    expect(conversation.nodes.find((node) => node.id === run.replyNodeId)?.content).toEqual([call])
  })
  it('并发工具中止后仍保留已经返回的结果', async () => {
    const app = await setup({
      agent: agent({ toolIds: ['probe'] }),
      driver: {
        id: 'driver',
        async generate() {
          return {
            content: [
              { type: 'tool-call', id: 'fast', name: 'probe', arguments: { slow: false } },
              { type: 'tool-call', id: 'slow', name: 'probe', arguments: { slow: true } },
            ],
          }
        },
      },
    })
    app.ctx.ai.registerTool(app.ctx, {
      id: 'probe',
      description: '',
      parameters: { type: 'object' },
      async execute(args, context) {
        if (args.slow) await delay(10000, undefined, { signal: context.signal })
        return { saved: true }
      },
    })
    const run = await app.ctx.ai.start(
      app.access,
      app.conversation.id,
      await command(app.ctx, app.access, app.conversation.id),
    )
    await expect
      .poll(async () =>
        (await app.ctx.ai.events(app.access, run.id)).some((event) => event.type === 'tool-end'),
      )
      .toBe(true)
    await app.ctx.ai.cancel(app.access, run.id)
    const saved = await app.ctx.ai.getRun(app.access, run.id)
    expect(saved.status).toBe('cancelled')
    expect(saved.messages.filter((message) => message.role === 'tool')).toMatchObject([
      {
        role: 'tool',
        content: [{ type: 'tool-result', id: 'fast', content: { saved: true }, isError: false }],
      },
    ])
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
    expect((await fetch(base + '/ai/conversations/events')).status).toBe(401)
    expect(
      (await fetch(base + '/ai/conversations/events?workspaceId=other-space', { headers })).status,
    ).toBe(403)
    const statusController = new AbortController()
    const statusStream = await fetch(base + '/ai/conversations/events', {
      headers,
      signal: statusController.signal,
    })
    const states: ConversationStateEvent[] = []
    const stateTask = readEvents<ConversationStateEvent>(
      statusStream,
      (event) => states.push(event),
      statusController.signal,
    ).catch((cause: unknown) => {
      if (!statusController.signal.aborted) throw cause
    })
    await vi.waitFor(() => expect(states[0]?.type).toBe('ready'))
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
    await vi.waitFor(() =>
      expect(states).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'conversation',
            conversation: expect.objectContaining({ id: conversation.id, activeRunId: run.id }),
          }),
          expect.objectContaining({
            type: 'conversation',
            conversation: expect.objectContaining({
              id: conversation.id,
              activeRunId: null,
              revision: 2,
            }),
          }),
        ]),
      ),
    )
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
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        type: 'conversation',
        conversation: { title: 'HTTP 归档测试', archivedAt: expect.any(Number), revision: 3 },
      }),
    )
    const foreign = await app.ctx.ai.createConversation(app.other, 'assistant', '其他空间的名称')
    await app.ctx.ai.updateConversation(app.other, foreign.id, { title: '不能泄露的名称' })
    await delay(30)
    expect(
      states.some((event) => event.type === 'conversation' && event.conversation.id === foreign.id),
    ).toBe(false)
    expect(
      (await fetch(base + `/ai/conversations/${foreign.id}`, { method: 'DELETE', headers })).status,
    ).toBe(404)
    expect(
      (await fetch(base + `/ai/conversations/${conversation.id}`, { method: 'DELETE' })).status,
    ).toBe(401)
    expect(
      (await fetch(base + `/ai/conversations/${conversation.id}`, { method: 'DELETE', headers }))
        .status,
    ).toBe(204)
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({ type: 'deleted', conversationId: conversation.id }),
    )
    statusController.abort()
    await stateTask
    expect(await (await fetch(base + '/ai/conversations', { headers })).json()).toEqual([])
    expect(
      await (await fetch(base + '/ai/conversations?archived=true', { headers })).json(),
    ).toEqual([])
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
    const unloading = await fetch(base + '/ai/conversations/events', { headers })
    const tail = unloading.text()
    await app.core.dispose()
    expect(await tail).toContain('event: ready')
  })
})
