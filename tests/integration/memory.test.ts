import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import ai from '@antarestra/ai'
import type {
  AgentPreset,
  JsonObject,
  RequestSnapshot,
  ModelContext,
  RunRecord,
} from '@antarestra/ai'
import * as agentCore from '@antarestra/plugin-ai-agent-core'
import * as memory from '@antarestra/plugin-memory'
import { countTokens, chunks, searchText } from '../../plugins/features/memory/src/text.js'
import { pluginId } from '../../plugins/features/memory/src/store.js'
import type { Tables } from '../../plugins/features/memory/src/store.js'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const toolIds = [
  'global_memory',
  'memory_create',
  'memory_read',
  'memory_update',
  'memory_forget',
  'memory_search',
  'memory_link',
]
const url = process.env.ANTARESTRA_TEST_POSTGRES
async function setup(
  options: {
    fallback?: boolean | 'mysql'
    budget?: number
    idleTimeoutMs?: number
    system?: string
    user?: string
    compact?: (request: RequestSnapshot, context: ModelContext) => Promise<string>
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  const backend = await ctx.plugin(
    database,
    options.fallback === 'mysql'
      ? { type: 'mysql', url: process.env.ANTARESTRA_TEST_MYSQL! }
      : options.fallback
        ? { filename: ':memory:' }
        : { type: 'postgresql', url: url! },
  )
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(ai, {
    ...(options.idleTimeoutMs ? { modelIdleTimeoutMs: options.idleTimeoutMs } : {}),
  })
  const workspace = randomUUID()
  const otherWorkspace = randomUUID()
  ctx.rbac.registerRequestSource(ctx, 'memory-test', {
    id: 'memory-test',
    resolve: async (request) => ({
      actorId: 'memory-test-actor',
      workspaceId: String(request),
      roles: ['user'],
    }),
  })
  const access = await ctx.ai.authorize('memory-test', workspace)
  const other = await ctx.ai.authorize('memory-test', otherWorkspace)
  const model = { providerId: 'memory-test', modelId: 'model' }
  ctx.ai.registerProvider(ctx, {
    id: model.providerId,
    title: '记忆测试',
    baseUrl: 'https://example.invalid',
    driverId: 'memory-test',
    models: [
      {
        id: 'model',
        title: '测试模型',
        contextWindow: 50000,
        maxOutputTokens: 4000,
        thinkingLevels: [],
        input: ['text'],
        output: ['text'],
        tools: true,
      },
    ],
  })
  let pending: { name: string; arguments: JsonObject }[] = []
  let replyIndex = 0
  const requests: RequestSnapshot[] = []
  ctx.ai.registerDriver(ctx, {
    id: 'memory-test',
    estimateTokens: () => 100,
    async generate(request, _connection, context) {
      requests.push(request)
      if (request.purpose === 'memory')
        return {
          content: [
            {
              type: 'text',
              text: await (options.compact?.(request, context) ?? Promise.resolve('用户偏好中文')),
            },
          ],
          stopReason: 'stop',
          usage: { input: 20, output: 5 },
        }
      if (replyIndex++ === 0 && pending.length)
        return {
          content: pending.map((call) => ({ type: 'tool-call', id: randomUUID(), ...call })),
        }
      return { content: [{ type: 'text', text: '完成' }] }
    },
  })
  await ctx.plugin(agentCore)
  const config = {
    globalTokenBudget: options.budget ?? 4096,
    ...(options.fallback ? { postgresUrl: url! } : {}),
  }
  let plugin = await ctx.plugin(memory, config)
  const preset: AgentPreset = {
    id: 'memory-test',
    version: '1',
    title: '测试',
    backendId: 'ai-agent-core',
    systemTemplate: options.system ?? '系统',
    userTemplate: options.user ?? '{{input}}',
    models: [model],
    defaultModel: model,
    toolIds,
    skillIds: [],
    extensions: {},
    contextPolicy: {
      compaction: { enabled: false, reserve: 1000, keepRecent: 1000, model: null, thinking: null },
      trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
    },
  }
  ctx.ai.registerAgent(ctx, preset)
  const conversation = await ctx.ai.createConversation(access, preset.id)
  const otherConversation = await ctx.ai.createConversation(other, preset.id)
  const sameSpace = await ctx.ai.createConversation(access, preset.id)
  // 独立查询所属上下文保留到测试清理，验证插件卸载不删除数据。
  const db = await ctx.database.postgres<Tables>(ctx, pluginId, options.fallback ? url : undefined)
  cleanups.push(async () => {
    for (const ws of [workspace, otherWorkspace]) {
      await db.deleteFrom('chunks').where('workspace_id', '=', ws).execute()
      await db.deleteFrom('links').where('workspace_id', '=', ws).execute()
      await db.deleteFrom('documents').where('workspace_id', '=', ws).execute()
      await db.deleteFrom('globals').where('workspace_id', '=', ws).execute()
    }
  })
  async function start(
    calls: typeof pending,
    text = '执行记忆操作',
    target = conversation.id,
    targetAccess = access,
  ) {
    pending = calls
    replyIndex = 0
    const state = await ctx.ai.getConversation(targetAccess, target)
    return ctx.ai.start(targetAccess, target, {
      operation: 'send',
      input: { text },
      idempotencyKey: randomUUID(),
      expectedRevision: state.conversation.revision,
      expectedNodeId: state.conversation.selectedNodeId,
    })
  }
  async function finish(run: RunRecord, targetAccess = access) {
    for (let i = 0; i < 500; i++) {
      const current = await ctx.ai.getRun(targetAccess, run.id)
      if (current.status !== 'running') return current
      await delay(10)
    }
    throw new Error('记忆测试运行超时')
  }
  async function call(
    name: string,
    args: JsonObject = {},
    target = conversation.id,
    targetAccess = access,
  ) {
    const run = await finish(
      await start([{ name, arguments: args }], undefined, target, targetAccess),
      targetAccess,
    )
    expect(run.status, JSON.stringify(run.error)).toBe('completed')
    const result = run.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool-result')
    expect(result?.type).toBe('tool-result')
    if (result?.type !== 'tool-result') throw new Error('工具未返回')
    return { data: result.content as JsonObject, error: result.isError, run }
  }
  return {
    ctx,
    db,
    access,
    other,
    conversation,
    sameSpace,
    otherConversation,
    requests,
    start,
    finish,
    call,
    backend,
    plugin: () => plugin,
    async reload(budget = config.globalTokenBudget) {
      await plugin.dispose()
      plugin = await ctx.plugin(memory, { ...config, globalTokenBudget: budget })
    },
  }
}

it('固定 Token 计数及中英文分词，长文完整分块', () => {
  expect(countTokens('')).toBe(0)
  expect(countTokens('hello world')).toBe(2)
  expect(countTokens('<|endoftext|>中文🙂')).toBeGreaterThan(0)
  expect(searchText('中文 TypeScript')).toContain('typescript')
  const text = '记忆文本 中文 TypeScript '.repeat(3000)
  expect(
    chunks(text)
      .map((part) => part.content)
      .join(''),
  ).toBe(text)
  expect(chunks(text).length).toBeGreaterThan(1)
})

it('非 PostgreSQL 主库缺少额外连接时明确拒绝', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await expect(ctx.database.postgres(ctx, 'missing-postgres')).rejects.toThrow(
    '额外 PostgreSQL 连接串',
  )
})

describe.skipIf(!url)('记忆工具与真实 PostgreSQL', () => {
  it.skipIf(!process.env.ANTARESTRA_TEST_MYSQL)(
    'MySQL 主库配合额外 PostgreSQL 保存记忆',
    async () => {
      const app = await setup({ fallback: 'mysql' })
      const created = await app.call('memory_create', { content: '独立 PostgreSQL 记忆' })
      expect(created.error).toBe(false)
      expect((await app.call('memory_read', { id: created.data.id! })).data.content).toBe(
        '独立 PostgreSQL 记忆',
      )
    },
  )

  it('预算边界不整理，非法文本不写入', async () => {
    const text = '中文与🙂'
    const app = await setup({ budget: countTokens(text) })
    const result = await app.call('global_memory', {
      action: 'set',
      content: text,
      expectedRevision: 0,
    })
    expect(result.data.tokens).toBe(result.data.budget)
    expect(result.data.compacted).toBe(false)
    expect(result.run.requests.some((request) => request.purpose === 'memory')).toBe(false)
    expect((await app.call('global_memory', { action: 'append', content: '\0' })).data.code).toBe(
      'invalid_memory',
    )
    expect((await app.call('global_memory', { action: 'get' })).data.content).toBe(text)
  })

  it('整理无活动超时后保留原文，后续工具仍可读取', async () => {
    const app = await setup({
      budget: 8,
      idleTimeoutMs: 50,
      compact: async (_request, context) => {
        await new Promise((_, reject) =>
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          }),
        )
        return '不可达'
      },
    })
    await app.call('global_memory', { action: 'set', content: '原文', expectedRevision: 0 })
    const failed = await app.call('global_memory', {
      action: 'append',
      content: '资料'.repeat(100),
    })
    expect(failed.data.code).toBe('model_idle_timeout')
    expect((await app.call('global_memory', { action: 'get' })).data.content).toBe('原文')
  })
  it.each([false, true])(
    '主库复用或独立 PostgreSQL（额外连接=%s），重载保留数据',
    async (fallback) => {
      const app = await setup({ fallback })
      const created = await app.call('memory_create', {
        content: '用户喜欢 TypeScript，咖啡和中文。',
      })
      expect(created.error).toBe(false)
      const id = String(created.data.id)
      await app.reload()
      const read = await app.call('memory_read', { id })
      expect(read.data.content).toContain('TypeScript')
      expect(read.data.createdConversationId).toBe(app.conversation.id)
      const found = await app.call('memory_search', { query: '中文 typescript' })
      expect((found.data.items as JsonObject[]).map((row) => row.id)).toEqual([id])
      const denied = await app.call('memory_read', { id }, app.otherConversation.id, app.other)
      expect(denied.data.code).toBe('memory_not_found')
      expect(
        (await app.call('memory_search', {}, app.otherConversation.id, app.other)).data.items,
      ).toEqual([])
    },
  )

  it('正文修改、版本冲突、索引同步和永久遗忘', async () => {
    const app = await setup()
    const id = String((await app.call('memory_create', { content: '旧关键词 苹果' })).data.id)
    expect(
      (await app.call('memory_update', { id, content: '新关键词 咖啡', expectedRevision: 1 })).data
        .revision,
    ).toBe(2)
    expect(
      (await app.call('memory_update', { id, content: '覆盖', expectedRevision: 1 })).data.code,
    ).toBe('memory_conflict')
    expect((await app.call('memory_search', { query: '苹果' })).data.items).toEqual([])
    expect((await app.call('memory_search', { query: '咖啡' })).data.items).toHaveLength(1)
    expect((await app.call('memory_forget', { id, expectedRevision: 1 })).data.code).toBe(
      'memory_conflict',
    )
    expect((await app.call('memory_forget', { id, expectedRevision: 2 })).data.deleted).toBe(true)
    expect((await app.call('memory_read', { id })).data.code).toBe('memory_not_found')
    expect(
      await app.db.selectFrom('links').selectAll().where('memory_id', '=', id).execute(),
    ).toEqual([])
    expect(
      await app.db.selectFrom('chunks').selectAll().where('memory_id', '=', id).execute(),
    ).toEqual([])
  })

  it('读取建立关联，搜索不关联；手动关联及会话删除保留来源', async () => {
    const app = await setup()
    const id = String((await app.call('memory_create', { content: '关联测试' })).data.id)
    await app.call('memory_search', {}, app.sameSpace.id)
    expect(
      (await app.call('memory_search', { conversationId: app.sameSpace.id })).data.items,
    ).toEqual([])
    await app.call('memory_read', { id }, app.sameSpace.id)
    expect(
      (await app.call('memory_search', { conversationId: app.sameSpace.id })).data.items,
    ).toHaveLength(1)
    await app.call('memory_link', { id, conversationId: app.sameSpace.id, action: 'remove' })
    expect(
      (await app.call('memory_search', { conversationId: app.sameSpace.id })).data.items,
    ).toEqual([])
    expect(
      (
        await app.call('memory_link', {
          id,
          conversationId: app.otherConversation.id,
          action: 'add',
        })
      ).error,
    ).toBe(true)
    await app.call('memory_link', { id, conversationId: app.sameSpace.id, action: 'add' })
    await app.ctx.ai.updateConversation(app.access, app.conversation.id, { archived: true })
    await app.ctx.ai.deleteConversation(app.access, app.conversation.id)
    const read = await app.call('memory_read', { id }, app.sameSpace.id)
    expect(read.data.createdConversationId).toBe(app.conversation.id)
    expect(read.data.conversationIds).toContain(app.conversation.id)
  })

  it('长文跨块全文召回、分页和向量预留', async () => {
    const app = await setup()
    const body = '前缀咖啡 ' + '中间资料 '.repeat(4000) + ' 结尾茶叶🙂'
    const id = String((await app.call('memory_create', { content: body })).data.id)
    expect((await app.call('memory_search', { query: '咖啡 茶叶' })).data.items).toHaveLength(1)
    const first = await app.call('memory_read', { id, limit: 5 })
    expect(first.data.nextOffset).toBe(5)
    const last = await app.call('memory_read', { id, offset: Array.from(body).length - 1 })
    expect(last.data.content).toBe('🙂')
    expect(last.data.nextOffset).toBeNull()
    expect((await app.call('memory_search', { mode: 'vector' })).data.code).toBe(
      'memory_vector_unavailable',
    )
  })

  it('全局记忆预算整理、清空和跨空间独立', async () => {
    const app = await setup({ budget: 16 })
    const result = await app.call('global_memory', {
      action: 'set',
      content: '很多不重要的临时细节。'.repeat(50),
      expectedRevision: 0,
    })
    expect(result.data.content).toBe('用户偏好中文')
    expect(result.data.compacted).toBe(true)
    expect(Number(result.data.tokens)).toBeLessThanOrEqual(16)
    expect(
      result.run.requests.some(
        (request) => request.purpose === 'memory' && request.tools.length === 0,
      ),
    ).toBe(true)
    expect(
      (await app.call('global_memory', { action: 'get' }, app.otherConversation.id, app.other)).data
        .content,
    ).toBe('')
    expect(
      (await app.call('global_memory', { action: 'set', content: '覆盖', expectedRevision: 0 }))
        .data.code,
    ).toBe('memory_conflict')
    expect(
      (await app.call('global_memory', { action: 'clear', expectedRevision: 1 })).data.tokens,
    ).toBe(0)
  })

  it('整理失败保留旧记忆，降低预算后自动整理', async () => {
    let fail = false
    const app = await setup({
      budget: 1000,
      compact: async () => (fail ? '仍然超预算的内容。'.repeat(100) : '重要事实'),
    })
    const original = '中文偏好，长期重要事实。'.repeat(20)
    await app.call('global_memory', { action: 'set', content: original, expectedRevision: 0 })
    await app.reload(10)
    fail = true
    expect((await app.call('global_memory', { action: 'get' })).data.code).toBe(
      'memory_budget_exceeded',
    )
    expect(
      (
        await app.db
          .selectFrom('globals')
          .selectAll()
          .where('workspace_id', '=', app.access.workspaceId)
          .executeTakeFirst()
      )?.content,
    ).toBe(original)
    fail = false
    expect((await app.call('global_memory', { action: 'get' })).data.content).toBe('重要事实')
  })

  it('系统和用户输入模板展开一次，原始输入不变', async () => {
    const app = await setup({ system: '记忆：{{global_memory}}' })
    await app.call('global_memory', {
      action: 'set',
      content: '喜欢中文，原样 {{unknown}}',
      expectedRevision: 0,
    })
    const run = await app.finish(await app.start([], '参考 {{global_memory}}'))
    expect(run.status).toBe('completed')
    expect(run.input.text).toBe('参考 {{global_memory}}')
    expect(run.requests[0]?.systemPrompt).toBe('记忆：喜欢中文，原样 {{unknown}}')
    expect(run.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: '参考 喜欢中文，原样 {{unknown}}' },
    ])
  })

  it('用户模板支持记忆，服务端变量不能覆盖，缺少插件不静默展开', async () => {
    const app = await setup({ user: '{{global_memory}} | {{input}}' })
    await app.call('global_memory', { action: 'set', content: '稳定偏好', expectedRevision: 0 })
    const run = await app.finish(await app.start([], '问题'))
    expect(run.requests[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: '稳定偏好 | 问题' },
    ])
    const state = await app.ctx.ai.getConversation(app.access, app.conversation.id)
    const forged = await app.ctx.ai.start(app.access, app.conversation.id, {
      operation: 'send',
      input: { text: '问题', variables: { global_memory: '伪造' } },
      idempotencyKey: randomUUID(),
      expectedRevision: state.conversation.revision,
      expectedNodeId: state.conversation.selectedNodeId,
    })
    expect((await app.finish(forged)).error?.message).toContain('不能覆盖')
    await app.plugin().dispose()
    const access = await app.ctx.ai.authorize('memory-test', randomUUID())
    const plain = {
      ...run.agent,
      id: 'without-memory',
      toolIds: [],
      systemTemplate: '{{global_memory}}',
    }
    app.ctx.ai.registerAgent(app.ctx, plain)
    const conversation = await app.ctx.ai.createConversation(access, plain.id)
    const absent = await app.ctx.ai.start(access, conversation.id, {
      operation: 'send',
      input: { text: '问题' },
      idempotencyKey: randomUUID(),
      expectedRevision: conversation.revision,
      expectedNodeId: conversation.selectedNodeId,
    })
    expect((await app.finish(absent, access)).error?.message).toBe('记忆插件未启用')
  })

  it('整理期间其他实例写入产生版本冲突，候选内容不能覆盖新值', async () => {
    let update: (() => Promise<void>) | undefined
    const app = await setup({
      budget: 8,
      compact: async () => {
        await update?.()
        return '整理结果'
      },
    })
    await app.call('global_memory', { action: 'set', content: '原值', expectedRevision: 0 })
    update = async () => {
      await app.db
        .updateTable('globals')
        .set({ content: '外部新值', revision: 2, tokens: countTokens('外部新值') })
        .where('workspace_id', '=', app.access.workspaceId)
        .execute()
    }
    expect(
      (await app.call('global_memory', { action: 'append', content: '详细资料'.repeat(100) })).data
        .code,
    ).toBe('memory_conflict')
    expect((await app.call('global_memory', { action: 'get' })).data.content).toBe('外部新值')
  })

  it('额外 PostgreSQL 查询跟随所属上下文和主后端回收', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(DatabaseProvider)
    const backend = await ctx.plugin(database, { filename: ':memory:' })
    const pg = await ctx.database.postgres<Tables>(ctx, pluginId, url)
    await pg.migrate((await import('../../plugins/features/memory/src/store.js')).migrations)
    await backend.dispose()
    expect(() => pg.selectFrom('globals')).toThrow('数据库连接已关闭')
  })

  it('同一工作空间并发追加不丢失，过期或伪造上下文拒绝', async () => {
    const app = await setup()
    const run = await app.finish(
      await app.start([
        { name: 'global_memory', arguments: { action: 'append', content: '第一项' } },
        { name: 'global_memory', arguments: { action: 'append', content: '第二项' } },
      ]),
    )
    expect(run.status).toBe('completed')
    const value = await app.call('global_memory', { action: 'get' })
    expect(value.data.content).toContain('第一项')
    expect(value.data.content).toContain('第二项')
    await expect(
      app.ctx.memory.global({
        runId: run.id,
        conversationId: app.conversation.id,
        workspaceId: app.access.workspaceId,
        actorId: 'memory-test-actor',
        agent: run.agent,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('运行上下文已失效')
  })

  it('卸载取消正在整理的运行且不写入候选记忆', async () => {
    let entered = false
    const app = await setup({
      budget: 8,
      compact: async (_request, context) => {
        entered = true
        await new Promise((_, reject) =>
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          }),
        )
        return '不可达'
      },
    })
    const run = await app.start([
      { name: 'global_memory', arguments: { action: 'append', content: '超预算资料'.repeat(100) } },
    ])
    for (let i = 0; i < 200 && !entered; i++) await delay(10)
    expect(entered).toBe(true)
    await app.plugin().dispose()
    expect((await app.finish(run)).status).toBe('cancelled')
    expect(
      await app.db
        .selectFrom('globals')
        .selectAll()
        .where('workspace_id', '=', app.access.workspaceId)
        .execute(),
    ).toEqual([])
  })
})
