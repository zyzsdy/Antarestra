import { applyEvent, emptyReply } from '../../plugins/features/chat-webui/client/stream.js'
import { replyContent } from '../../plugins/features/chat-webui/client/reply-content.js'
import { historyToolDetails } from '../../plugins/features/chat-webui/client/tool-details.js'
import { createServer } from 'node:http'
import type { RequestListener } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as agentCore from '@antarestra/plugin-ai-agent-core'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import ai from '@antarestra/ai'
import provider from '@antarestra/plugin-ai-provider'
import type { ProviderView } from '@antarestra/plugin-ai-provider'
import {
  builtinModels,
  discover,
  candidates,
} from '../../plugins/features/ai-provider/src/catalog.js'
import {
  driver,
  resolveModel,
  useBuiltinAdapter,
} from '../../plugins/features/ai-provider/src/driver.js'
import { syncModels } from '../../plugins/features/ai-provider/client/models.js'
import {
  publicProvider,
  validateModel,
  validateProvider,
  validateBuiltinTools,
} from '../../plugins/features/ai-provider/src/validation.js'
import type { Tables } from '../../plugins/features/ai-provider/src/store.js'
const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const input = {
  id: 'example',
  name: '测试提供商',
  note: '测试备注',
  builtin: '',
  api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'abc-super-secret-1234',
  headers: { 'x-extra': 'header-value' },
}
const model = {
  id: 'test-model',
  title: '测试模型',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  input: ['text'],
  output: ['text'],
  tools: true,
  thinkingLevels: ['low', 'high'],
}
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
    bootstrapPassword: 'provider-password-42',
  })
  const fiber = await ctx.plugin(provider, {})
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
    password: 'provider-password-42',
  })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'test',
    resolve: async () => ({ actorId: 'tester', workspaceId: 'space', roles: ['user'] }),
  })
  const access = await ctx.ai.authorize('test', {})
  return { ctx, fiber, core, cookie, request, access }
}
it('管理 API 拒绝访客与普通用户，响应只含占位密钥，数据库保存原值', async () => {
  const app = await setup()
  expect((await app.request('/ai-providers')).status).toBe(401)
  const member = await app.request('/auth/local/local/register', '', {
    email: 'user@example.com',
    password: 'member-password-42',
    displayName: '普通用户',
  })
  expect(member.status).toBe(201)
  const memberLogin = await app.request('/auth/local/local/login', '', {
    email: 'user@example.com',
    password: 'member-password-42',
  })
  const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0]!
  expect((await app.request('/ai-providers', memberCookie)).status).toBe(403)
  expect((await app.request('/ai-providers', memberCookie, input)).status).toBe(403)
  const response = await app.request('/ai-providers', app.cookie, input)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const view = (await response.json()) as ProviderView
  expect(view).not.toHaveProperty('apiKey')
  expect(view.apiKeyPlaceholder).toMatch(/^abc\*+1234$/)
  const raw = await app.ctx.database
    .scope<Tables>(app.ctx, '@antarestra/plugin-ai-provider')
    .selectFrom('providers')
    .selectAll()
    .executeTakeFirstOrThrow()
  expect(JSON.parse(raw.payload).apiKey).toBe(input.apiKey)
  expect(await (await app.request('/ai-providers', app.cookie)).text()).not.toContain(input.apiKey)
  expect(JSON.stringify(await app.ctx.ai.catalog(app.access))).not.toContain(input.apiKey)
})
it('密钥留空保留、输入替换、短密钥全遮罩，拒绝脱敏值和过期版本', async () => {
  const { ctx } = await setup()
  const first = await ctx.aiProvider.save(input)
  const second = await ctx.aiProvider.save(
    { ...input, apiKey: '', revision: first.revision },
    input.id,
  )
  expect(second.apiKeyPlaceholder).toBe(first.apiKeyPlaceholder)
  await expect(
    ctx.aiProvider.save({ ...input, revision: first.revision }, input.id),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    ctx.aiProvider.save(
      { ...input, apiKey: second.apiKeyPlaceholder, revision: second.revision },
      input.id,
    ),
  ).rejects.toMatchObject({ status: 400 })
  const third = await ctx.aiProvider.save(
    { ...input, apiKey: 'new-secret-5678', revision: second.revision },
    input.id,
  )
  expect(third.apiKeyPlaceholder).toMatch(/^new\*+5678$/)
  expect(publicProvider(validateProvider({ ...input, apiKey: 'short' })).apiKeyPlaceholder).toBe(
    '*******',
  )
})
it('模型写入注册目录，重复和无效模型不改变数据库，删除后移除注册', async () => {
  const app = await setup()
  const first = await app.ctx.aiProvider.save(input)
  const saved = await app.ctx.aiProvider.models(input.id, {
    revision: first.revision,
    models: [model],
  })
  expect((await app.ctx.ai.catalog(app.access)).providers[0]?.models[0]?.id).toBe(model.id)
  await expect(
    app.ctx.aiProvider.models(input.id, { revision: saved.revision, models: [model, model] }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    app.ctx.aiProvider.models(input.id, {
      revision: saved.revision,
      models: [{ ...model, contextWindow: 0 }],
    }),
  ).rejects.toMatchObject({ status: 400 })
  expect(app.ctx.aiProvider.detail(input.id).models).toHaveLength(1)
  await app.ctx.aiProvider.remove(input.id, saved.revision)
  expect((await app.ctx.ai.catalog(app.access)).providers).toHaveLength(0)
})
it('SQLite 文件重启恢复提供商和模型，独立卸载及 AI 依赖恢复不重复注册', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-provider-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }))
  const filename = join(directory, 'provider.sqlite')
  const app = await setup(filename)
  const first = await app.ctx.aiProvider.save(input)
  await app.ctx.aiProvider.models(input.id, { revision: first.revision, models: [model] })
  await app.fiber.dispose()
  expect((await app.ctx.ai.catalog(app.access)).providers).toHaveLength(0)
  await app.ctx.plugin(provider, {})
  expect((await app.ctx.ai.catalog(app.access)).providers).toHaveLength(1)
  await app.core.dispose()
  await app.ctx.plugin(ai, {})
  const access = await app.ctx.ai.authorize('test', {})
  expect((await app.ctx.ai.catalog(access)).providers).toHaveLength(1)
  await app.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(app.ctx), 1)
  const restored = await setup(filename)
  expect(restored.ctx.aiProvider.detail(input.id).models[0]?.id).toBe(model.id)
  expect(restored.ctx.aiProvider.detail(input.id).apiKeyPlaceholder).toMatch(/^abc\*+1234$/)
})
async function remote(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('监听失败')
  return `http://127.0.0.1:${address.port}`
}
it.each(['anthropic-messages', 'openai-completions', 'openai-responses'])(
  'opencode-go 内置目录包含所有协议的模型（当前接口 %s）',
  async (api) => {
    const record = validateProvider({ ...input, builtin: 'opencode-go', api })
    const builtin = builtinModels('opencode-go')
    expect(new Set(builtin.map((model) => model.api)).size).toBe(3)
    expect(builtin.length).toBeGreaterThan(2)
    const expected = [...new Set(builtin.map((model) => model.id))].sort()
    const models = candidates(record)
    expect(models.map((model) => model.id).sort()).toEqual(expected)
    expect(models.every((model) => model.source === 'builtin')).toBe(true)
    record.baseUrl = await remote((_req, res) => {
      res.statusCode = 503
      res.end()
    })
    const fallback = await discover(record, new AbortController().signal)
    expect(fallback.warning).toContain('失败')
    expect(fallback.models).toEqual(models)
  },
)
it('opencode-go 官方端点按模型选择协议，保留内置兼容参数和用户能力配置', () => {
  const record = validateProvider({
    ...input,
    builtin: 'opencode-go',
    api: 'anthropic-messages',
    baseUrl: 'https://opencode.ai/zen/go',
  })
  record.models = candidates(record).map(validateModel)
  expect(driver(record).id).toBe(`ai-provider:${record.id}`)
  for (const builtin of builtinModels('opencode-go')) {
    const definition = candidates(record).find((model) => model.id === builtin.id)!
    const resolved = resolveModel(record, { ...definition, maxOutputTokens: 1024 }, record.baseUrl)
    expect(resolved).toMatchObject({
      id: builtin.id,
      api: builtin.api,
      baseUrl: builtin.baseUrl,
      cost: builtin.cost,
      maxTokens: 1024,
    })
    expect(resolved.compat).toEqual(builtin.compat)
    expect(resolved.thinkingLevelMap).toEqual(builtin.thinkingLevelMap)
    expect(resolveModel(record, definition, record.baseUrl + '/').api).toBe(builtin.api)
    expect(useBuiltinAdapter(record, definition.id, record.baseUrl)).toBe(true)
  }
  const remote = validateModel({ ...model, id: 'mimo-v2.6-flash' })
  record.models.push(remote)
  const unknown = resolveModel(record, remote, record.baseUrl)
  expect(unknown.api).toBe('openai-completions')
  expect(unknown.baseUrl).toBe('https://opencode.ai/zen/go/v1')
  expect(useBuiltinAdapter(record, unknown.id, record.baseUrl)).toBe(true)
  const future = validateModel({ ...model, id: 'future-go-model' })
  record.models.push(future)
  expect(resolveModel(record, future, record.baseUrl).api).toBe(record.api)
  expect(useBuiltinAdapter(record, future.id, record.baseUrl)).toBe(true)
})
it('自定义网关不被内置模型的协议和端点覆盖', () => {
  const record = validateProvider({ ...input, builtin: 'opencode-go', api: 'anthropic-messages' })
  const builtin = builtinModels('opencode-go').find((model) => model.api === 'openai-completions')!
  const definition = candidates(record).find((model) => model.id === builtin.id)!
  record.models = [validateModel(definition)]
  const resolved = resolveModel(record, definition, record.baseUrl)
  expect(resolved.api).toBe(record.api)
  expect(resolved.baseUrl).toBe(input.baseUrl)
  expect(resolved.compat).toBeUndefined()
  expect(useBuiltinAdapter(record, definition.id, record.baseUrl)).toBe(false)
})
it('自定义提供商即使使用内置模型 ID 和官方地址也始终使用默认接口', () => {
  const record = validateProvider({ ...input, baseUrl: 'https://opencode.ai/zen/go' })
  const builtin = builtinModels('opencode-go').find((model) => model.api === 'anthropic-messages')!
  const resolved = resolveModel(record, validateModel({ ...model, id: builtin.id }), record.baseUrl)
  expect(resolved.api).toBe(record.api)
  expect(resolved.baseUrl).toBe(record.baseUrl)
  expect(resolved.provider).toBe(record.id)
})
it('其他内置提供商的同名模型不会改变所选提供商的默认请求配置', () => {
  const record = validateProvider({
    ...input,
    builtin: 'opencode-go',
    api: 'anthropic-messages',
    baseUrl: 'https://opencode.ai/zen/go',
  })
  const known = new Set(builtinModels(record.builtin).map((model) => model.id))
  const other = builtinModels('openai').find((model) => !known.has(model.id))!
  expect(other).toBeDefined()
  const resolved = resolveModel(record, validateModel({ ...model, id: other.id }), record.baseUrl)
  expect(resolved.api).toBe(record.api)
  expect(resolved.baseUrl).toBe(record.baseUrl)
  expect(resolved.provider).toBe(record.builtin)
})
it('真实 HTTP 目录合并内置与远端同 ID，发送密钥和 Header，失败保留内置目录', async () => {
  const record = validateProvider({ ...input, builtin: 'openai', api: 'openai-responses' })
  const builtin = candidates(record)[0]!
  let fail = false
  record.baseUrl = await remote((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${input.apiKey}`)
    expect(req.headers['x-extra']).toBe('header-value')
    res.setHeader('content-type', 'application/json')
    res.statusCode = fail ? 401 : 200
    res.end(
      JSON.stringify({ data: [{ id: builtin.id }, { id: 'remote-only' }, { id: 'remote-only' }] }),
    )
  })
  const result = await discover(record, new AbortController().signal)
  expect(result.warning).toBe('')
  expect(result.models.find((item) => item.id === builtin.id)).toMatchObject({
    source: 'both',
    contextWindow: builtin.contextWindow,
  })
  expect(result.models.filter((item) => item.id === 'remote-only')).toHaveLength(1)
  expect(result.models.find((item) => item.id === 'remote-only')).toMatchObject({
    source: 'remote',
    contextWindow: 128000,
    maxOutputTokens: 65535,
  })
  fail = true
  const fallback = await discover(record, new AbortController().signal)
  expect(fallback.warning).toContain('失败')
  expect(fallback.models).toEqual(candidates(record))
  expect(JSON.stringify(fallback)).not.toContain(input.apiKey)
})
it.each(['', 'openai'])(
  'API 模型使用 pi-ai 内置参数，兼容自定义提供商和不同接口（%s）',
  async (builtin) => {
    const reference = candidates(
      validateProvider({ ...input, builtin: 'openai', api: 'openai-responses' }),
    ).find((model) => model.thinkingLevels.length > 0 && model.input.includes('image'))!
    expect(reference).toBeDefined()
    const baseUrl = await remote((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            { id: reference.id, context_length: 123, max_output_tokens: 45 },
            { id: reference.id },
            { id: 'remote-only', context_length: 65536, max_output_tokens: 8192 },
          ],
        }),
      )
    })
    const result = await discover(
      validateProvider({ ...input, builtin, baseUrl }),
      new AbortController().signal,
    )
    expect(result.warning).toBe('')
    expect(result.models.filter((model) => model.id === reference.id)).toEqual([
      { ...reference, source: 'both' },
    ])
    expect(result.models.find((model) => model.id === 'remote-only')).toMatchObject({
      source: 'remote',
      contextWindow: 65536,
      maxOutputTokens: 8192,
      input: ['text'],
      thinkingLevels: [],
    })
    if (!builtin) expect(result.models).toHaveLength(2)
  },
)
it('同步覆盖已有模型参数，保留未选模型并新增模型，保存后可重复同步', async () => {
  const { ctx } = await setup()
  const saved = await ctx.aiProvider.save(input)
  const initial = await ctx.aiProvider.models(input.id, {
    revision: saved.revision,
    models: [model, { ...model, id: 'keep' }],
  })
  const baseUrl = await remote((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: model.id }, { id: 'new' }] }))
  })
  const { models: selected } = await discover(
    validateProvider({ ...input, baseUrl }),
    new AbortController().signal,
  )
  const merged = syncModels(initial.models, selected)
  expect(merged.map((model) => model.id)).toEqual([model.id, 'keep', 'new'])
  expect(merged[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 65535 })
  expect(merged[0]).not.toHaveProperty('source')
  expect(merged[1]).toEqual(initial.models[1])
  const updated = await ctx.aiProvider.models(input.id, {
    revision: initial.revision,
    models: merged,
  })
  expect(updated.models).toEqual(merged)
  expect(syncModels(updated.models, selected)).toEqual(merged)
})
it('远端缺失或无效参数使用新默认值，最大输出仍受上下文限制', async () => {
  const baseUrl = await remote((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        data: [
          { id: 'invalid', context_length: 0, max_output_tokens: -1 },
          { id: 'small', context_length: 8192 },
        ],
      }),
    )
  })
  const result = await discover(
    validateProvider({ ...input, baseUrl }),
    new AbortController().signal,
  )
  expect(result.models[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 65535 })
  expect(result.models[1]).toMatchObject({ contextWindow: 8192, maxOutputTokens: 8192 })
})
it('拒绝不安全 URL、Header 注入和未知接口，注册失败不留下数据库记录', async () => {
  const app = await setup()
  for (const changes of [
    { baseUrl: 'https://user:password@example.com' },
    { baseUrl: 'file:///etc/passwd' },
    { headers: { authorization: 'value\r\nInjected: value' } },
    { headers: { Host: 'another.example' } },
    { api: 'not-an-api' },
  ])
    await expect(app.ctx.aiProvider.save({ ...input, ...changes })).rejects.toMatchObject({
      status: 400,
    })
  app.ctx.ai.registerProvider(app.ctx, {
    id: input.id,
    title: '占用 ID',
    driverId: 'other',
    baseUrl: '',
    models: [],
  })
  await expect(app.ctx.aiProvider.save(input)).rejects.toMatchObject({
    code: 'duplicate_registration',
  })
  expect(app.ctx.aiProvider.list()).toEqual([])
  expect(
    await app.ctx.database
      .scope<Tables>(app.ctx, '@antarestra/plugin-ai-provider')
      .selectFrom('providers')
      .selectAll()
      .execute(),
  ).toEqual([])
})
it('Google 目录翻页与模型 ID 归一化，不在 URL 传递密钥', async () => {
  const paths: string[] = []
  const baseUrl = await remote((req, res) => {
    paths.push(req.url!)
    expect(req.headers['x-goog-api-key']).toBe(input.apiKey)
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url?.includes('pageToken=next')
          ? {
              models: [
                {
                  name: 'models/second',
                  displayName: '第二个模型',
                  inputTokenLimit: 65536,
                  outputTokenLimit: 8192,
                },
              ],
            }
          : { models: [{ name: 'models/first' }], nextPageToken: 'next' },
      ),
    )
  })
  const result = await discover(
    validateProvider({ ...input, api: 'google-generative-ai', baseUrl }),
    new AbortController().signal,
  )
  expect(paths).toEqual(['/models', '/models?pageToken=next'])
  expect(result.models.map((model) => model.id)).toEqual(['first', 'second'])
  expect(result.models[1]).toMatchObject({
    title: '第二个模型',
    contextWindow: 65536,
    maxOutputTokens: 8192,
  })
})
it('卸载取消并等待正在进行的目录 HTTP 请求', async () => {
  const app = await setup()
  let started!: () => void
  const received = new Promise<void>((resolve) => {
    started = resolve
  })
  const baseUrl = await remote(() => started())
  await app.ctx.aiProvider.save({ ...input, baseUrl })
  const request = app.ctx.aiProvider.discover(input.id, true)
  await received
  await app.fiber.dispose()
  expect((await request).warning).toContain('失败')
  expect((await app.ctx.ai.catalog(app.access)).providers).toEqual([])
})
it.each([input.apiKey, ''])(
  'pi-ai 通过 OpenAI 兼容流调用自定义服务，支持独立凭据与无密钥服务',
  async (credential) => {
    let fail = false
    let received: { messages: { role: string; content: unknown }[] }
    const baseUrl = await remote(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      received = JSON.parse(body)
      expect(req.url).toBe('/chat/completions')
      expect(req.headers.authorization).toBe(credential ? `Bearer ${credential}` : undefined)
      expect(req.headers['x-extra']).toBe('header-value')
      if (fail) {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { message: `密钥无效 ${credential}` } }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'test',
            object: 'chat.completion.chunk',
            created: 1,
            model: model.id,
            choices: [
              { index: 0, delta: { role: 'assistant', content: '接入成功' }, finish_reason: null },
            ],
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            id: 'test',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      )
    })
    const record = validateProvider({ ...input, baseUrl })
    record.models = [{ ...model, input: ['text'], output: ['text'] }]
    const instance = driver(record)
    const request: import('@antarestra/ai').RequestSnapshot = {
      model: { providerId: input.id, modelId: model.id },
      thinking: null,
      parameters: {},
      systemPrompt: '测试',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      tools: [],
    }
    const context = {
      runId: 'test',
      conversationId: 'test',
      actorId: 'test',
      workspaceId: 'test',
      signal: new AbortController().signal,
      agent: {
        id: 'test',
        version: '1',
        title: '测试',
        backendId: 'test',
        systemTemplate: '',
        userTemplate: '',
        models: [],
        defaultModel: { providerId: input.id, modelId: model.id },
        toolIds: [],
        skillIds: [],
        extensions: {},
      },
    }
    const generate = () =>
      instance.generate(request, { baseUrl, credential }, context, async () => {})
    const result = await generate()
    expect(result.content).toContainEqual({ type: 'text', text: '接入成功' })
    record.models[0]!.input = ['text', 'image']
    request.messages[0]!.content.push(
      { type: 'image', resourceId: 'image', mimeType: 'image/png' },
      { type: 'file', resourceId: 'pdf', mimeType: 'application/pdf', filename: '说明.pdf' },
    )
    await instance.generate(
      request,
      {
        baseUrl,
        credential,
        resources: new Map([
          ['image', { data: 'aW1hZ2U=', mimeType: 'image/png', filename: '截图.png' }],
          ['pdf', { data: 'cGRm', mimeType: 'application/pdf', filename: '说明.pdf' }],
        ]),
      },
      context,
      async () => {},
    )
    expect(received!.messages.find((message) => message.role === 'user')!.content).toEqual([
      { type: 'text', text: '你好' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      {
        type: 'file',
        file: { filename: '说明.pdf', file_data: 'data:application/pdf;base64,cGRm' },
      },
    ])
    request.messages[0]!.content = [{ type: 'text', text: '你好' }]
    fail = true
    await expect(generate()).rejects.toMatchObject({
      code: 'provider_request_failed',
      message: expect.stringContaining('401'),
    })
    await expect(generate()).rejects.toMatchObject({
      message: expect.not.stringContaining(credential || 'abc-super-secret-1234'),
    })
  },
)
it('思考续接信息经过项目 DTO 往返，仅回传给同一连接和模型', async () => {
  const requests: { messages: { role: string; reasoning_content?: string }[] }[] = []
  const baseUrl = await remote(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'text/event-stream')
    res.end(
      'data: ' +
        JSON.stringify({
          id: 'test',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', reasoning_content: '用于下一轮的思考', content: '回答' },
              finish_reason: null,
            },
          ],
        }) +
        '\n\ndata: ' +
        JSON.stringify({ id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        '\n\ndata: [DONE]\n\n',
    )
  })
  const record = validateProvider({ ...input, baseUrl })
  record.models = [{ ...model, input: ['text'], output: ['text'] }]
  const instance = driver(record)
  const ref = { providerId: input.id, modelId: model.id }
  const context = {
    runId: 'test',
    conversationId: 'test',
    actorId: 'test',
    workspaceId: 'test',
    signal: new AbortController().signal,
    agent: {
      id: 'test',
      version: '1',
      title: '测试',
      backendId: 'test',
      systemTemplate: '',
      userTemplate: '',
      models: [ref],
      defaultModel: ref,
      toolIds: [],
      skillIds: [],
      extensions: {},
    },
  }
  const request = { model: ref, thinking: null, parameters: {}, systemPrompt: '测试', tools: [] }
  const first = await instance.generate(
    { ...request, messages: [{ role: 'user', content: [{ type: 'text', text: '第一轮' }] }] },
    { baseUrl, credential: input.apiKey },
    context,
    async () => {},
  )
  expect(first.content).toContainEqual({
    type: 'thinking',
    text: '用于下一轮的思考',
    continuation: {
      model: ref,
      driverId: `ai-provider:${input.id}`,
      signature: 'reasoning_content',
    },
  })
  const history: import('@antarestra/ai').ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: JSON.parse(JSON.stringify(first.content)) },
    { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
  ]
  await instance.generate(
    { ...request, messages: history },
    { baseUrl, credential: input.apiKey },
    context,
    async () => {},
  )
  expect(requests[1]?.messages.find((item) => item.role === 'assistant')?.reasoning_content).toBe(
    '用于下一轮的思考',
  )
  await instance.generate(
    { ...request, model: { ...ref, providerId: 'other' }, messages: history },
    { baseUrl, credential: input.apiKey },
    context,
    async () => {},
  )
  expect(
    requests[2]?.messages.find((item) => item.role === 'assistant')?.reasoning_content,
  ).toBeUndefined()
})

it('内置工具经 Responses 请求发送，提供商执行不会进入客户端工具循环，并受模型和 Agent 范围限制', async () => {
  const { ctx, access, fiber } = await setup()
  const received: { tools?: { type: string; name?: string }[] }[] = []
  const baseUrl = await remote(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const payload = JSON.parse(body)
    received.push(payload)
    const hosted = (payload.tools ?? [])
      .filter((t: { type: string }) => t.type !== 'function')
      .map((t: { type: string }) => ({
        id: `hosted-${t.type}`,
        type: `${t.type}_call`,
        status: 'completed',
        ...(t.type === 'web_search'
          ? { action: { type: 'search', query: '测试' } }
          : { result: 'aW1hZ2U=', output_format: 'png' }),
      }))
    const message = {
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '已完成', annotations: [] }],
    }
    const commentary = {
      ...message,
      id: 'msg-commentary',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '先检索资料。', annotations: [] }],
    }
    const events = [
      { type: 'response.created', response: { id: 'resp-test', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: commentary },
      { type: 'response.output_text.delta', output_index: 0, delta: '先检索资料。' },
      { type: 'response.output_item.done', output_index: 0, item: commentary },
      ...hosted.flatMap((item: object, index: number) => [
        { type: 'response.output_item.added', output_index: index + 1, item },
        { type: 'response.output_item.done', output_index: index + 1, item },
      ]),
      { type: 'response.output_item.added', output_index: hosted.length + 1, item: message },
      { type: 'response.output_item.done', output_index: hosted.length + 1, item: message },
      {
        type: 'response.completed',
        response: {
          id: 'resp-test',
          status: 'completed',
          output: [commentary, ...hosted, message],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
    res.setHeader('content-type', 'text/event-stream')
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  let saved = await ctx.aiProvider.save({ ...input, api: 'openai-responses', baseUrl })
  saved = await ctx.aiProvider.models(input.id, {
    revision: saved.revision,
    models: [model, { ...model, id: 'other' }],
  })
  const tools = [
    {
      name: 'web_search',
      type: 'web_search',
      modelIds: [model.id],
      enabled: true,
      options: { search_context_size: 'low' },
    },
    {
      name: 'draw_image',
      type: 'image_generation',
      modelIds: [model.id],
      enabled: true,
      options: {},
    },
    {
      name: 'documents',
      type: 'file_search',
      modelIds: [model.id],
      enabled: true,
      options: { vector_store_ids: ['vs-test'] },
    },
  ]
  saved = await ctx.aiProvider.builtinTools(input.id, { revision: saved.revision, tools })
  expect(ctx.ai.capabilities().tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'provider:example:web_search' })]),
  )
  await expect(
    ctx.aiProvider.builtinTools(input.id, { revision: saved.revision - 1, tools }),
  ).rejects.toMatchObject({ status: 409 })
  expect(() =>
    validateBuiltinTools([{ ...tools[0], modelIds: ['missing'] }], saved.models),
  ).toThrow()
  expect(() =>
    validateBuiltinTools([{ ...tools[0], options: { type: 'function' } }], saved.models),
  ).toThrow()
  await ctx.plugin(agentCore)
  const execute = vi.fn(async () => '客户端结果')
  ctx.ai.registerTool(ctx, {
    id: 'local_tool',
    description: '本地工具',
    parameters: { type: 'object', properties: {} },
    execute,
  })
  async function run(id: string, modelId: string, toolIds: string[]) {
    const ref = { providerId: input.id, modelId }
    ctx.ai.registerAgent(ctx, {
      id,
      version: '1',
      title: '测试',
      contextPolicy: {
        compaction: { enabled: true, reserve: 1000, keepRecent: 1000, model: null, thinking: null },
        trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
      },
      backendId: 'ai-agent-core',
      systemTemplate: '',
      userTemplate: '{{input}}',
      models: [ref],
      defaultModel: ref,
      toolIds,
      skillIds: [],
      extensions: {},
    })
    const conversation = await ctx.ai.createConversation(access, id)
    const started = await ctx.ai.start(access, conversation.id, {
      operation: 'send',
      input: { text: '测试' },
      idempotencyKey: id,
      expectedRevision: conversation.revision,
      expectedNodeId: null,
    })
    await vi.waitFor(async () =>
      expect((await ctx.ai.getRun(access, started.id)).status).not.toBe('running'),
    )
    const result = await ctx.ai.getRun(access, started.id)
    expect(result.status).toBe('completed')
    expect(result.requests).toHaveLength(1)
    return result
  }
  const result = await run('allowed', model.id, [
    'local_tool',
    'provider:example:web_search',
    'provider:example:draw_image',
    'provider:example:documents',
  ])
  expect(received[0]?.tools).toEqual(
    expect.arrayContaining([
      { type: 'web_search', search_context_size: 'low' },
      { type: 'image_generation' },
      { type: 'file_search', vector_store_ids: ['vs-test'] },
      expect.objectContaining({ type: 'function', name: 'local_tool' }),
    ]),
  )
  expect(
    result.messages.flatMap((m) => m.content).filter((b) => b.type === 'provider-tool'),
  ).toHaveLength(3)
  const content = result.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
  expect(content.map((block) => block.type)).toEqual([
    'text',
    'provider-tool',
    'provider-tool',
    'provider-tool',
    'text',
  ])
  const replay = emptyReply()
  const events = await ctx.ai.events(access, result.id, 0)
  for (const event of events) {
    applyEvent(replay, event)
    if (event.type === 'provider-tool') {
      expect(replay.pending[0]).toEqual({ type: 'text', text: '先检索资料。' })
      expect(replyContent(replay.pending, replay.tools).body).toBe('')
    }
  }
  expect(replay.completed).toEqual(content)
  expect(replyContent(content, historyToolDetails(result)).body).toBe('已完成')
  expect(execute).not.toHaveBeenCalled()
  await run('wrong-model', 'other', ['provider:example:web_search'])
  expect(received.at(-1)?.tools ?? []).toEqual([])
  await run('not-authorized', model.id, [])
  expect(received.at(-1)?.tools ?? []).toEqual([])
  await ctx.aiProvider.builtinTools(input.id, {
    revision: saved.revision,
    tools: tools.map((tool) => ({ ...tool, enabled: false })),
  })
  await run('disabled', model.id, ['provider:example:web_search'])
  expect(received.at(-1)?.tools ?? []).toEqual([])
  await fiber.dispose()
  expect(ctx.ai.capabilities().tools.map((t) => t.id)).not.toContain('provider:example:web_search')
})
