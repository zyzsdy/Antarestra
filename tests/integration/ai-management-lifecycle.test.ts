import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import ai from '@antarestra/ai'
import provider from '@antarestra/plugin-ai-provider'
import agents, { defaultAgentId } from '@antarestra/plugin-ai-agents'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const core = await ctx.plugin(ai, {})
  const providerFiber = await ctx.plugin(provider, {})
  const agentsFiber = await ctx.plugin(agents)
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  const identityProvider = await ctx.rbac.registerProvider(ctx, 'test-auth', 'test-auth')
  await ctx.database.transaction(ctx, async (transaction) => {
    const identity = await identityProvider.provision(transaction, 'admin', '测试管理员')
    await ctx.rbac.bootstrap(transaction, identity.principalId)
  })
  const session = await identityProvider.issue('admin')
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'test',
    resolve: async () => ({ actorId: 'tester', workspaceId: 'space', roles: ['user'] }),
  })
  const access = await ctx.ai.authorize('test', {})
  const base = `http://127.0.0.1:${ctx.server.address!.port}`
  const request = (path: string) =>
    fetch(base + path, { headers: { Authorization: `Bearer ${session.token}` } })
  return { ctx, core, providerFiber, agentsFiber, access, request }
}

async function saveConfiguration(ctx: Context) {
  const saved = await ctx.aiProvider.save({
    id: 'test-provider',
    name: '后台提供商',
    note: '',
    builtin: '',
    api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${ctx.server.address!.port}/test-model`,
    apiKey: 'fixture-key',
    headers: {},
  })
  await ctx.aiProvider.models(saved.id, {
    revision: saved.revision,
    models: [
      {
        id: 'test-model',
        title: '后台模型',
        contextWindow: 100000,
        maxOutputTokens: 1000,
        input: ['text'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
    ],
  })
  const initial = ctx.aiAgents.detail(defaultAgentId)
  await ctx.aiAgents.save({ ...initial, title: '后台助理', skillIds: [] }, defaultAgentId)
}

function expectConfiguration(ctx: Context) {
  expect(ctx.aiProvider.list()).toHaveLength(1)
  expect(ctx.ai.capabilities().providers).toMatchObject([
    { id: 'test-provider', models: [{ id: 'test-model' }] },
  ])
  expect(ctx.aiAgents.list()).toHaveLength(1)
  expect(ctx.aiAgents.detail(defaultAgentId).title).toBe('后台助理')
  expect(ctx.ai.defaultAgentId).toBe(defaultAgentId)
}

it('无 WebUI 时初始化并从 SQLite 恢复模型和助理，AI 依赖恢复后只注册一次', async () => {
  const app = await setup()
  expect(app.ctx.webui).toBeUndefined()
  expect(app.ctx.ai.defaultAgentId).toBe(defaultAgentId)
  await saveConfiguration(app.ctx)
  await app.providerFiber.dispose()
  await app.agentsFiber.dispose()
  await app.ctx.plugin(provider, {})
  await app.ctx.plugin(agents)
  expectConfiguration(app.ctx)
  await app.core.dispose()
  expect(app.ctx.aiProvider).toBeUndefined()
  expect(app.ctx.aiAgents).toBeUndefined()
  await app.ctx.plugin(ai, {})
  await expect.poll(() => app.ctx.ai.defaultAgentId).toBe(defaultAgentId)
  expectConfiguration(app.ctx)
  expect((await app.request('/api/ai-providers')).status).toBe(200)
  expect((await app.request('/api/ai-agents')).status).toBe(200)
})

it('WebUI 反复加载和卸载只改变页面注册，后台服务与活动运行保持有效', async () => {
  const app = await setup()
  await saveConfiguration(app.ctx)
  const providerService = app.ctx.aiProvider
  const agentsService = app.ctx.aiAgents
  let modelCalls = 0
  app.ctx.server.use(app.ctx, async (http, next) => {
    if (http.path !== '/test-model/chat/completions') return next()
    modelCalls++
    http.type = 'text/event-stream'
    http.body =
      [
        {
          id: 'test-response',
          object: 'chat.completion.chunk',
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '后台运行正常' } }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join('') + 'data: [DONE]\n\n'
  })
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  app.ctx.ai.registerBackend(app.ctx, {
    id: 'ai-agent-core',
    async run(runtime) {
      entered.resolve()
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          runtime.context.signal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
      await runtime.request()
    },
  })
  const conversation = await app.ctx.ai.createConversation(app.access)
  const run = await app.ctx.ai.start(app.access, conversation.id, {
    operation: 'send',
    input: { text: '等待页面壳维护完成' },
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    expectedNodeId: null,
  })
  await entered.promise
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const webui = await app.ctx.plugin(WebUI)
      await expect
        .poll(() =>
          app.ctx.webui
            .getEntries()
            .map((entry) => entry.id)
            .sort(),
        )
        .toEqual(['ai-agents', 'ai-provider'])
      await webui.dispose()
      expect(app.ctx.webui).toBeUndefined()
      expect((await app.request('/webui/entries.json')).status).toBe(404)
      // Cordis 每次读取服务会生成代理；检查旧服务引用的数据仍在，未被卸载清空。
      expect(providerService.list()).toHaveLength(1)
      expect(agentsService.list()).toHaveLength(1)
      expectConfiguration(app.ctx)
      const providers = await app.request('/api/ai-providers')
      expect(providers.status).toBe(200)
      expect(await providers.json()).toMatchObject([{ id: 'test-provider' }])
      const agents = await app.request('/api/ai-agents')
      expect(agents.status).toBe(200)
      expect(await agents.json()).toMatchObject({ agents: [{ title: '后台助理' }] })
      expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('running')
    }
  } finally {
    gate.resolve()
  }
  await expect
    .poll(async () => (await app.ctx.ai.getRun(app.access, run.id)).status)
    .toBe('completed')
  expect(modelCalls).toBe(1)
  expect((await app.ctx.ai.getRun(app.access, run.id)).messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: [{ type: 'text', text: '后台运行正常' }],
  })
})

it('独立卸载后台插件回收对应页面、HTTP 路由与能力，重新加载恢复数据', async () => {
  const app = await setup()
  await saveConfiguration(app.ctx)
  await app.ctx.plugin(WebUI)
  await app.providerFiber.dispose()
  expect(app.ctx.aiProvider).toBeUndefined()
  expect(app.ctx.ai.capabilities().providers).toEqual([])
  expect(app.ctx.webui.getEntries().map((entry) => entry.id)).toEqual(['ai-agents'])
  expect((await app.request('/api/ai-providers')).status).toBe(404)
  expect((await app.request('/api/ai-agents')).status).toBe(200)
  await app.agentsFiber.dispose()
  expect(app.ctx.aiAgents).toBeUndefined()
  expect(app.ctx.ai.defaultAgentId).toBeNull()
  expect(app.ctx.webui.getEntries()).toEqual([])
  expect((await app.request('/api/ai-agents')).status).toBe(404)
  await app.ctx.plugin(provider, {})
  await app.ctx.plugin(agents)
  expectConfiguration(app.ctx)
  expect(
    app.ctx.webui
      .getEntries()
      .map((entry) => entry.id)
      .sort(),
  ).toEqual(['ai-agents', 'ai-provider'])
  expect((await app.request('/api/ai-providers')).status).toBe(200)
  expect((await app.request('/api/ai-agents')).status).toBe(200)
})
