import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import type { Config as DatabaseConfig } from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import ai from '@antarestra/ai'
import type { AgentPreset, JsonObject, RunContext } from '@antarestra/ai'
import * as agentCore from '@antarestra/plugin-ai-agent-core'
import wakeTasks from '@antarestra/plugin-wake-tasks'
import type { Config } from '@antarestra/plugin-wake-tasks'
import { pluginId } from '../../plugins/features/wake-tasks/src/store.js'
import type { Tables } from '../../plugins/features/wake-tasks/src/store.js'
import { nextOccurrence, schedule } from '../../plugins/features/wake-tasks/src/schedule.js'

const poll = (fn: () => unknown) => expect.poll(fn, { timeout: 4000 })
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
const config: Config = { pollIntervalMs: 100, batchSize: 2, concurrency: 2, leaseMs: 3000 }
const model = { providerId: 'provider', modelId: 'model' }
const agent: AgentPreset = {
  id: 'assistant',
  title: '测试助理',
  version: '1',
  backendId: 'ai-agent-core',
  systemTemplate: '系统',
  userTemplate: '{{input}}',
  models: [model],
  defaultModel: model,
  toolIds: ['wake_task_create', 'wake_task_list', 'wake_task_cancel', 'capture'],
  skillIds: [],
  extensions: {},
  contextPolicy: {
    compaction: { enabled: false, reserve: 1000, keepRecent: 1000, model: null, thinking: null },
    trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
  },
}
const future = (changes: JsonObject = {}): JsonObject => ({
  triggerAt: new Date(Date.now() + 3600000).toISOString(),
  reason: '检查进度',
  prompt: '请检查项目进度并总结。',
  ...changes,
})
async function setup(
  filename = ':memory:',
  options: Partial<Config> = {},
  databaseConfig?: DatabaseConfig,
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  const backend = await ctx.plugin(database, databaseConfig ?? { filename })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const core = await ctx.plugin(ai, {})
  let allowed = true
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'test',
    resolve: async (workspace) => ({
      actorId: 'actor',
      workspaceId: String(workspace),
      roles: ['user'],
    }),
    resolveBackground: async (actorId, workspaceId) =>
      allowed ? { actorId, workspaceId, roles: ['user'] } : undefined,
  })
  const access = await ctx.ai.authorize('test', 'space')
  const other = await ctx.ai.authorize('test', 'other')
  ctx.ai.registerProvider(ctx, {
    id: 'provider',
    title: '测试连接',
    baseUrl: 'https://example.invalid',
    driverId: 'driver',
    models: [
      {
        id: 'model',
        title: '测试模型',
        contextWindow: 10000,
        maxOutputTokens: 1000,
        input: ['text'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
    ],
  })
  let plan: { name: string; arguments: JsonObject } | undefined
  let captured: RunContext | undefined
  let block = false
  let fail = false
  const inputs: string[] = []
  ctx.ai.registerTool(ctx, {
    id: 'capture',
    description: '捕获测试上下文',
    parameters: { type: 'object' },
    async execute(_args, context) {
      captured = context
      return {}
    },
  })
  ctx.ai.registerDriver(ctx, {
    id: 'driver',
    async generate(request, _connection, context) {
      if (plan) {
        const call = plan
        plan = undefined
        return { content: [{ type: 'tool-call', id: randomUUID(), ...call }] }
      }
      const text = request.messages
        .find((m) => m.role === 'user')
        ?.content.find((b) => b.type === 'text')
      if (text?.type === 'text' && text.text !== '设置任务') {
        inputs.push(text.text)
        if (fail) throw new Error('测试模型失败')
        if (block) await delay(60000, undefined, { signal: context.signal })
      }
      return { content: [{ type: 'text', text: '完成' }] }
    },
  })
  await ctx.plugin(agentCore)
  ctx.ai.registerAgent(ctx, agent)
  const plugin = await ctx.plugin(wakeTasks, { ...config, ...options })
  const db = ctx.database.scope<Tables>(ctx, pluginId)
  const conversation = await ctx.ai.createConversation(access, agent.id)
  async function call(name: string, args: JsonObject = {}, space = access) {
    plan = { name, arguments: args }
    const conv = await ctx.ai.createConversation(space, agent.id)
    const run = await ctx.ai.start(space, conv.id, {
      operation: 'send',
      input: { text: '设置任务' },
      expectedNodeId: null,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    })
    await poll(async () => (await ctx.ai.getRun(space, run.id)).status).not.toBe('running')
    const record = await ctx.ai.getRun(space, run.id)
    expect(record.error).toBeNull()
    const result = record.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool-result')
    return { record, result, conversation: conv }
  }
  async function create(args = future()) {
    const result = await call('wake_task_create', args)
    expect(result.result).toMatchObject({ isError: false })
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('source_conversation_id', '=', result.conversation.id)
      .executeTakeFirstOrThrow()
    return row
  }
  async function due(id: string, at = Date.now() - 1000) {
    await db
      .updateTable('tasks')
      .set({ next_at: at, available_at: at })
      .where('id', '=', id)
      .execute()
  }
  const row = (id: string) =>
    db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  return {
    ctx,
    access,
    other,
    core,
    backend,
    plugin,
    db,
    conversation,
    inputs,
    call,
    create,
    due,
    row,
    revoke() {
      allowed = false
    },
    block() {
      block = true
    },
    fail() {
      fail = true
    },
    captured: () => captured,
  }
}

it('严格校验一次性默认值、时区、未来日期和周期，并跳过错过的周期', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  expect(schedule({ ...future(), triggerAt: '2026-01-01T09:00:00+08:00' }, now)).toMatchObject({
    at: now + 3600000,
    interval: null,
  })
  for (const args of [
    { triggerAt: '2026-01-01T09:00:00' },
    { triggerAt: '2026-02-30T09:00:00Z' },
    { triggerAt: '2025-01-01T09:00:00Z' },
    { intervalSeconds: 60 },
    { mode: 'interval' },
    { mode: 'interval', intervalSeconds: 0 },
    { reason: '  ' },
    { prompt: '' },
  ])
    expect(() => schedule(future(args), now)).toThrow()
  expect(nextOccurrence(1000, 60000, 181000)).toBe(241000)
})

it('工具落库自动关联身份与助理，并在原空间的新会话提交原提示词且只执行一次', async () => {
  const app = await setup()
  const row = await app.create()
  expect(row).toMatchObject({
    workspace_id: 'space',
    actor_id: 'actor',
    agent_id: 'assistant',
    interval_ms: null,
    status: 'pending',
  })
  await app.due(row.id)
  await poll(async () => (await app.row(row.id)).status).toBe('completed')
  const task = await app.row(row.id)
  expect(task.last_conversation_id).not.toBe(row.source_conversation_id)
  const target = await app.ctx.ai.getConversation(app.access, task.last_conversation_id!)
  expect(target.conversation).toMatchObject({
    workspaceId: 'space',
    actorId: 'actor',
    agentId: 'assistant',
  })
  expect((await app.ctx.ai.getRun(app.access, task.last_run_id!)).input.text).toBe(row.prompt)
  await Promise.all([app.ctx.wakeTasks.tick(), app.ctx.wakeTasks.tick()])
  expect(app.inputs).toEqual([row.prompt])
})

it('真实 SQLite 文件在重建应用后恢复到期任务，启动立即读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wake-tasks-'))
  directories.push(directory)
  const filename = join(directory, 'tasks.sqlite')
  const first = await setup(filename)
  const task = await first.create()
  await first.plugin.dispose()
  await first.due(task.id)
  await first.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(first.ctx), 1)
  const second = await setup(filename, { pollIntervalMs: 60000 })
  await poll(async () => (await second.row(task.id)).status).toBe('completed')
  expect(second.inputs).toEqual([task.prompt])
})

it('周期任务补执行一次并跳过积压，下一次使用独立会话', async () => {
  const app = await setup()
  const task = await app.create(future({ mode: 'interval', intervalSeconds: 60 }))
  await app.due(task.id, Date.now() - 180000)
  await poll(async () => (await app.row(task.id)).last_run_id).not.toBeNull()
  await poll(async () => (await app.row(task.id)).status).toBe('pending')
  const first = await app.row(task.id)
  expect(first.next_at).toBeGreaterThan(Date.now())
  expect(first.next_at).toBeLessThanOrEqual(Date.now() + 60000)
  await app.due(task.id)
  await expect
    .poll(async () => (await app.row(task.id)).last_conversation_id)
    .not.toBe(first.last_conversation_id)
  expect(app.inputs).toEqual([task.prompt, task.prompt])
})

it('只读取有限的到期任务并限制同时执行数量，竞争实例不重复执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wake-competition-'))
  directories.push(directory)
  const filename = join(directory, 'tasks.sqlite')
  const app = await setup(filename, { concurrency: 1, batchSize: 1 })
  const second = await setup(filename, { concurrency: 1, pollIntervalMs: 60000 })
  await second.ctx.wakeTasks.tick()
  app.block()
  second.block()
  const tasks = [await app.create(), await app.create()]
  // 构造大量未来任务，调度只读取索引命中的到期页。
  await app.db
    .insertInto('tasks')
    .values(
      Array.from({ length: 200 }, () => ({
        ...tasks[0]!,
        id: randomUUID(),
        conversation_id: randomUUID(),
      })),
    )
    .execute()
  await app.due(tasks[0]!.id)
  await app.due(tasks[1]!.id)
  await poll(() => app.inputs.length).toBe(1)
  await app.ctx.wakeTasks.tick()
  expect(app.inputs).toHaveLength(1)
  expect(
    await app.db.selectFrom('tasks').select('id').where('status', '=', 'running').execute(),
  ).toHaveLength(1)
  await second.ctx.wakeTasks.tick()
  await poll(() => second.inputs.length).toBe(1)
  await Promise.all([app.ctx.wakeTasks.tick(), second.ctx.wakeTasks.tick()])
  expect(app.inputs).toHaveLength(1)
  expect(second.inputs).toHaveLength(1)
})

it('分页和取消限制在当前空间，拒绝伪造或失效上下文', async () => {
  const app = await setup()
  const task = await app.create()
  const denied = await app.call('wake_task_cancel', { id: task.id }, app.other)
  expect(denied.result).toMatchObject({ isError: true })
  expect((await app.row(task.id)).status).toBe('pending')
  const otherList = await app.call('wake_task_list', {}, app.other)
  expect(JSON.stringify(otherList.result)).not.toContain(task.id)
  await app.call('capture')
  await expect(app.ctx.wakeTasks.create(future(), app.captured()!)).rejects.toMatchObject({
    code: 'forbidden',
  })
  await expect(
    app.ctx.wakeTasks.list({ ...app.captured()!, workspaceId: 'other' }),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await app.call('wake_task_cancel', { id: task.id })
  await app.due(task.id)
  await app.ctx.wakeTasks.tick()
  expect((await app.row(task.id)).status).toBe('cancelled')
  expect(app.inputs).toHaveLength(0)
})

it('后台授权撤销时不启动新会话', async () => {
  const app = await setup()
  const task = await app.create()
  app.revoke()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).status).toBe('failed')
  expect((await app.row(task.id)).last_error).toContain('授权')
  expect(app.inputs).toHaveLength(0)
})

it('任务列表使用游标读取下一页且不重复', async () => {
  const app = await setup()
  const expected = [await app.create(), await app.create(), await app.create()]
    .map((task) => task.id)
    .sort()
  const page = async (after = '') => {
    const { result } = await app.call('wake_task_list', { after, limit: 2 })
    return result!.content as { tasks: { id: string }[]; nextCursor: string | null }
  }
  const first = await page()
  expect(first.tasks.map((task) => task.id)).toEqual(expected.slice(0, 2))
  expect(first.nextCursor).toBe(expected[1])
  const last = await page(first.nextCursor!)
  expect(last.tasks.map((task) => task.id)).toEqual(expected.slice(2))
  expect(last.nextCursor).toBeNull()
})

it('耗时运行持续续租，不会因超过初始租约而再次执行', async () => {
  const app = await setup()
  app.block()
  const task = await app.create()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).last_run_id).not.toBeNull()
  const before = await app.row(task.id)
  await delay(3100)
  const after = await app.row(task.id)
  expect(after.lease_token).toBe(before.lease_token)
  expect(after.available_at).toBeGreaterThan(Date.now())
  await app.ctx.wakeTasks.tick()
  expect(app.inputs).toHaveLength(1)
})

it('原身份提供者尚未加载时保持待重试，恢复后正常执行', async () => {
  const app = await setup()
  const task = await app.create()
  await app.db
    .updateTable('tasks')
    .set({ source_provider: 'late' })
    .where('id', '=', task.id)
    .execute()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).attempts).toBe(1)
  expect((await app.row(task.id)).status).toBe('pending')
  app.ctx.rbac.registerRequestSource(app.ctx, 'test', {
    id: 'late',
    resolve: async () => undefined,
    resolveBackground: async (actorId, workspaceId) => ({ actorId, workspaceId, roles: ['user'] }),
  })
  await poll(async () => (await app.row(task.id)).status).toBe('completed')
  expect(app.inputs).toHaveLength(1)
})

it('执行已入库但调度确认丢失时复用原会话及幂等运行', async () => {
  const app = await setup()
  const task = await app.create()
  const access = await app.ctx.ai.authorizeBackground(
    app.ctx,
    'test',
    task.actor_id,
    task.workspace_id,
  )
  await app.ctx.ai.createConversation(access, task.agent_id, '预先交接', task.conversation_id)
  const run = await app.ctx.ai.start(access, task.conversation_id, {
    operation: 'send',
    input: { text: task.prompt },
    idempotencyKey: task.conversation_id,
    expectedNodeId: null,
    expectedRevision: 0,
  })
  await poll(async () => (await app.ctx.ai.getRun(access, run.id)).status).toBe('completed')
  await app.db
    .updateTable('tasks')
    .set({ status: 'running', lease_token: '崩溃进程', available_at: Date.now() - 1 })
    .where('id', '=', task.id)
    .execute()
  await poll(async () => (await app.row(task.id)).status).toBe('completed')
  expect((await app.row(task.id)).last_run_id).toBe(run.id)
  expect(app.inputs).toEqual([task.prompt])
})

it('独立卸载取消活动运行、回收轮询，重载保留任务', async () => {
  const app = await setup()
  app.block()
  const task = await app.create()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).last_run_id).not.toBeNull()
  const runId = (await app.row(task.id)).last_run_id!
  const service = app.ctx.wakeTasks
  const cancel = vi.spyOn(app.ctx.ai.running.get(runId)!, 'cancel')
  await app.plugin.dispose()
  expect(cancel).toHaveBeenCalled()
  expect((await app.ctx.ai.getRun(app.access, runId)).status).toBe('cancelled')
  await service.tick()
  expect(app.inputs).toHaveLength(1)
  await app.ctx.plugin(wakeTasks, config)
  await poll(async () => (await app.row(task.id)).status).toBe('failed')
  expect(app.inputs).toHaveLength(1)
})

it('模型失败记录失败状态，不重复执行一次性任务', async () => {
  const app = await setup()
  app.fail()
  const task = await app.create()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).status).toBe('failed')
  expect((await app.row(task.id)).last_error).toContain('失败')
  await app.ctx.wakeTasks.tick()
  expect(app.inputs).toHaveLength(1)
})

it('取消正在执行的任务会终止对应 AI 运行', async () => {
  const app = await setup()
  app.block()
  const task = await app.create()
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).last_run_id).not.toBeNull()
  await app.call('wake_task_cancel', { id: task.id })
  const runId = (await app.row(task.id)).last_run_id!
  await poll(async () => (await app.ctx.ai.getRun(app.access, runId)).status).toBe('cancelled')
  expect((await app.row(task.id)).status).toBe('cancelled')
})

it('依赖卸载取消运行，恢复 AI 依赖后调度服务自动重新就绪', async () => {
  const app = await setup()
  const task = await app.create()
  const old = app.ctx.wakeTasks
  await app.core.dispose()
  await old.tick()
  expect(app.inputs).toHaveLength(0)
  await app.ctx.plugin(ai, {})
  await poll(() => app.ctx.wakeTasks !== old).toBe(true)
  expect((await app.row(task.id)).status).toBe('pending')
})

it('交接暂时失败时退避重试，复用已建会话', async () => {
  const app = await setup()
  const task = await app.create()
  const original = app.ctx.ai.start
  const start = vi.spyOn(app.ctx.ai, 'start').mockRejectedValueOnce(new Error('临时故障'))
  await app.due(task.id)
  await poll(async () => (await app.row(task.id)).attempts).toBe(1)
  start.mockImplementation(original)
  await poll(async () => (await app.row(task.id)).status).toBe('completed')
  expect((await app.row(task.id)).last_conversation_id).toBe(task.conversation_id)
  expect(app.inputs).toEqual([task.prompt])
})

it.skipIf(!process.env.ANTARESTRA_TEST_WAKE_POSTGRES)(
  '真实 PostgreSQL 完成迁移、工具写入、租约执行和周期推进',
  async () => {
    const app = await setup(
      undefined,
      {},
      { type: 'postgresql', url: process.env.ANTARESTRA_TEST_WAKE_POSTGRES! },
    )
    const task = await app.create(future({ mode: 'interval', intervalSeconds: 60 }))
    await app.due(task.id)
    await poll(async () => (await app.row(task.id)).last_run_id).not.toBeNull()
    await poll(async () => (await app.row(task.id)).status).toBe('pending')
    expect((await app.row(task.id)).next_at).toBeGreaterThan(Date.now())
    expect(app.inputs).toEqual([task.prompt])
  },
)
