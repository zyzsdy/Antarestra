import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import ai from '@antarestra/ai'
import agents, { defaultAgentId, newAgent } from '@antarestra/plugin-ai-agents'
import type { AgentRecord } from '@antarestra/plugin-ai-agents'
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function setup(filename = ':memory:') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(WebUI)
  const core = await ctx.plugin(ai, {})
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'agents-password-42',
  })
  const fiber = await ctx.plugin(agents)
  const base = `http://127.0.0.1:${ctx.server.address!.port}/api`
  const request = (path: string, cookie = '', body?: object, method = 'POST') =>
    fetch(base + path, {
      method: body ? method : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = await request('/auth/local/local/login', '', {
    email: 'admin@example.com',
    password: 'agents-password-42',
  })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'test',
    resolve: async (request) => ({
      actorId: 'tester',
      workspaceId: String(request),
      roles: ['user'],
    }),
  })
  const access = await ctx.ai.authorize('test', 'space')
  const other = await ctx.ai.authorize('test', 'other')
  return { ctx, fiber, core, cookie, request, access, other }
}
function capabilities(ctx: Context, wait = false) {
  ctx.ai.registerDriver(ctx, {
    id: 'driver',
    async generate(_r, _c, context) {
      if (wait) await delay(10000, undefined, { signal: context.signal })
      return { content: [{ type: 'text', text: '测试回答' }] }
    },
  })
  ctx.ai.registerBackend(ctx, {
    id: 'ai-agent-core',
    async run(runtime) {
      await runtime.request()
    },
  })
  return ctx.ai.registerProvider(ctx, {
    id: 'provider',
    title: '测试提供商',
    baseUrl: '',
    driverId: 'driver',
    models: [
      {
        id: 'model',
        title: '测试模型',
        contextWindow: 100000,
        maxOutputTokens: 1000,
        input: ['text'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
    ],
  })
}
async function start(app: Awaited<ReturnType<typeof setup>>, agentId?: string) {
  const conversation = await app.ctx.ai.createConversation(app.access, agentId)
  return app.ctx.ai.start(app.access, conversation.id, {
    operation: 'send',
    input: { text: '问题' },
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    expectedNodeId: null,
  })
}
it('SQLite 初始化唯一默认助理、持久保存修改并重启恢复，数据库拒绝删除保护由服务落实', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-agents-'))
  directories.push(directory)
  const filename = join(directory, 'agents.sqlite')
  const app = await setup(filename)
  const initial = app.ctx.aiAgents.detail(defaultAgentId)
  expect(initial).toMatchObject({ title: '默认助理', models: null, toolIds: null, skillIds: null })
  expect(initial.systemTemplate).toContain('不编造')
  const changed = await app.ctx.aiAgents.save(
    {
      ...initial,
      title: '我的助理',
      systemTemplate: '专属提示 {{input}}',
      toolIds: [],
      skillIds: [],
    },
    defaultAgentId,
  )
  await expect(app.ctx.aiAgents.remove(defaultAgentId, changed.revision)).rejects.toMatchObject({
    status: 403,
  })
  await app.ctx.fiber.dispose()
  const restored = await setup(filename)
  expect(restored.ctx.aiAgents.list()).toHaveLength(1)
  expect(restored.ctx.aiAgents.detail(defaultAgentId)).toEqual(changed)
})
it('管理 API 拒绝未登录和普通用户；默认会话跨空间隔离', async () => {
  const app = await setup()
  expect((await app.request('/ai-agents')).status).toBe(401)
  expect((await app.request('/ai-agents/template-variables')).status).toBe(401)
  await app.request('/auth/local/local/register', '', {
    email: 'member@example.com',
    password: 'member-password-42',
    displayName: '普通用户',
  })
  const login = await app.request('/auth/local/local/login', '', {
    email: 'member@example.com',
    password: 'member-password-42',
  })
  const member = login.headers.get('set-cookie')!.split(';')[0]!
  for (const [path, body, method] of [
    ['/ai-agents', undefined, 'GET'],
    ['/ai-agents/capabilities', undefined, 'GET'],
    ['/ai-agents/template-variables', undefined, 'GET'],
    ['/ai-agents', newAgent('bad', '越权'), 'POST'],
    [`/ai-agents/${defaultAgentId}`, { revision: 1 }, 'DELETE'],
  ] as const)
    expect((await app.request(path, member, body, method)).status).toBe(403)
  const result = await app.request('/ai/conversations', member, {})
  expect(result.status).toBe(201)
  expect(await result.json()).toMatchObject({ agentId: defaultAgentId })
  const conversation = await app.ctx.ai.createConversation(app.access)
  await expect(app.ctx.ai.getConversation(app.other, conversation.id)).rejects.toMatchObject({
    status: 404,
  })
  expect(
    (await app.request(`/ai-agents/${defaultAgentId}`, app.cookie, { revision: 1 }, 'DELETE'))
      .status,
  ).toBe(403)
})
it('变量目录包含内置与已注册说明，不解析空间内容，卸载后移除', async () => {
  const app = await setup()
  let resolved = false
  const plugin = await app.ctx.plugin({
    inject: ['ai'],
    apply(ctx: Context) {
      ctx.ai.registerTemplateVariable(ctx, {
        id: 'test_memory',
        description: '测试空间记忆',
        async resolve() {
          resolved = true
          return '不应出现在目录中的私密内容'
        },
      })
      ctx.ai.registerTemplateVariable(ctx, { id: 'no_description', resolve: async () => '' })
    },
  })
  const response = await app.request('/ai-agents/template-variables', app.cookie)
  expect(response.status).toBe(200)
  const entries = await response.json()
  expect(entries).toEqual([
    { id: 'input', description: expect.stringContaining('本次用户输入') },
    { id: 'test_memory', description: '测试空间记忆' },
    { id: 'no_description', description: expect.stringContaining('尚未提供含义说明') },
  ])
  expect(resolved).toBe(false)
  await plugin.dispose()
  expect(await (await app.request('/ai-agents/template-variables', app.cookie)).json()).toEqual([
    { id: 'input', description: expect.any(String) },
  ])
})
it('API 创建编辑校验、重复 ID 与并发修订冲突，默认助理之外可删除', async () => {
  const app = await setup()
  const create = () => app.request('/ai-agents', app.cookie, newAgent('writer', '写作助理'))
  expect((await create()).status).toBe(200)
  expect((await create()).status).toBe(409)
  const original = app.ctx.aiAgents.detail('writer')
  expect(
    (await app.request('/ai-agents/writer', app.cookie, { ...original, title: '新名字' }, 'PUT'))
      .status,
  ).toBe(200)
  expect((await app.request('/ai-agents/writer', app.cookie, original, 'PUT')).status).toBe(409)
  expect(
    (
      await app.request('/ai-agents', app.cookie, {
        ...newAgent('bad', '无效'),
        toolIds: ['use_skill'],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await app.request('/ai-agents', app.cookie, {
        ...newAgent('bad', '无效'),
        models: [],
        defaultModel: { providerId: 'p', modelId: 'm' },
      })
    ).status,
  ).toBe(400)
  expect(
    (await app.request('/ai-agents/writer', app.cookie, { revision: 2 }, 'DELETE')).status,
  ).toBe(200)
  expect(app.ctx.aiAgents.list()).toHaveLength(1)
})
it('全部范围动态接入模型工具和 Skill；无模型仍可管理，运行给出明确错误', async () => {
  const app = await setup()
  await expect(start(app)).rejects.toMatchObject({ code: 'capability_unavailable' })
  const removeProvider = capabilities(app.ctx)
  const removeTool = app.ctx.ai.registerTool(app.ctx, {
    id: 'search',
    description: '搜索',
    parameters: {},
    async execute() {
      return null
    },
  })
  const first = await start(app)
  expect(first.agent).toMatchObject({
    models: [{ providerId: 'provider', modelId: 'model' }],
    toolIds: ['search'],
    skillIds: [],
  })
  const removeSkills = app.ctx.ai.registerSkills(app.ctx, {
    async createTool(selection) {
      expect(selection).toBeNull()
      return {
        id: 'use_skill',
        description: '技能',
        parameters: {},
        async execute() {
          return null
        },
      }
    },
  })
  const next = await start(app)
  expect(next.agent.skillIds).toBeNull()
  await removeTool()
  expect((await start(app)).agent.toolIds).toEqual([])
  await removeSkills()
  await removeProvider()
  await expect(start(app)).rejects.toMatchObject({ code: 'capability_unavailable' })
})
it('运行固定配置快照；更新不打断运行，卸载清理运行与默认选择，恢复不重置数据', async () => {
  const app = await setup()
  capabilities(app.ctx, true)
  const run = await start(app)
  const original = app.ctx.aiAgents.detail(defaultAgentId)
  await app.ctx.aiAgents.save(
    { ...original, title: '修改名称', systemTemplate: '新的提示词', models: [], toolIds: [] },
    defaultAgentId,
  )
  expect((await app.ctx.ai.getRun(app.access, run.id)).agent.title).toBe('默认助理')
  expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('running')
  await app.fiber.dispose()
  expect((await app.ctx.ai.getRun(app.access, run.id)).status).toBe('cancelled')
  expect(app.ctx.ai.defaultAgentId).toBeNull()
  await app.ctx.plugin(agents)
  expect(app.ctx.aiAgents.detail(defaultAgentId).title).toBe('修改名称')
  await expect(start(app)).rejects.toMatchObject({ code: 'capability_unavailable' })
})
it('自定义 Agent 的模型与工具限制进入快照，禁止指定范围外模型', async () => {
  const app = await setup()
  capabilities(app.ctx)
  const record: AgentRecord = {
    ...newAgent('limited', '受限助理'),
    models: [{ providerId: 'provider', modelId: 'model' }],
    toolIds: [],
    skillIds: [],
  }
  await app.ctx.aiAgents.save({ ...record })
  const conversation = await app.ctx.ai.createConversation(app.access, 'limited')
  await expect(
    app.ctx.ai.start(app.access, conversation.id, {
      operation: 'send',
      input: { text: '问题' },
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      expectedNodeId: null,
      model: { providerId: 'provider', modelId: 'forbidden' },
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
  expect((await start(app, 'limited')).agent).toMatchObject({
    id: 'limited',
    toolIds: [],
    skillIds: [],
  })
})

it('AI 依赖卸载再接入时重新注册，并保留默认助理的修改', async () => {
  const app = await setup()
  const value = app.ctx.aiAgents.detail(defaultAgentId)
  await app.ctx.aiAgents.save({ ...value, title: '保留的名字' }, defaultAgentId)
  await app.core.dispose()
  await app.ctx.plugin(ai, {})
  await expect.poll(() => app.ctx.ai.defaultAgentId).toBe(defaultAgentId)
  expect(app.ctx.aiAgents.detail(defaultAgentId).title).toBe('保留的名字')
  expect(app.ctx.aiAgents.list()).toHaveLength(1)
})

it('独特提示词模板进入模型请求，目录公开默认标识且不泄露凭据', async () => {
  const app = await setup()
  capabilities(app.ctx)
  await app.ctx.aiAgents.save({
    ...newAgent('translator', '翻译助理'),
    systemTemplate: '请翻译：{{input}}',
    userTemplate: '原文：{{input}}',
    skillIds: [],
  })
  const started = await start(app, 'translator')
  await expect
    .poll(async () => (await app.ctx.ai.getRun(app.access, started.id)).status)
    .toBe('completed')
  const completed = await app.ctx.ai.getRun(app.access, started.id)
  expect(completed.requests[0]?.systemPrompt).toBe('请翻译：问题')
  expect(completed.requests[0]?.messages.at(-1)?.content).toEqual([
    { type: 'text', text: '原文：问题' },
  ])
  const catalog = await app.ctx.ai.catalog(app.access)
  expect(catalog.defaultAgentId).toBe(defaultAgentId)
  expect(catalog.agents.map((a) => a.id)).toContain('translator')
  expect(
    JSON.stringify(await (await app.request('/ai-agents/capabilities', app.cookie)).json()),
  ).not.toContain('baseUrl')
})
