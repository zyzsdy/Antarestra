import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import ai from '@antarestra/ai'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import provider from '@antarestra/plugin-ai-provider'
import { CodexSubscriptions } from '../../plugins/features/ai-provider/src/codex.js'
import { CodexStorage } from '../../plugins/features/ai-provider/src/codex-storage.js'
import {
  codexScope,
  codexIssuer,
  codexResource,
} from '../../plugins/features/ai-provider/src/codex-oauth.js'
import { subscriptionPayload } from '../../plugins/features/ai-provider/src/codex-models.js'
import type {
  CodexState,
  CodexLoginView,
} from '../../plugins/features/ai-provider/src/codex-types.js'

const contexts: Context[] = []
const directories: string[] = []
const realFetch = globalThis.fetch
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }
let nonce = ''
let clientId = 'oaiapp_test'
let identity: Record<string, unknown> = {}
let scope = codexScope
let refreshes = 0
let revokeFailure = false
let exchanged: URLSearchParams | undefined
function jwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: codexIssuer,
      sub: 'test-subject',
      aud: clientId,
      nonce,
      email: 'test@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...identity,
    }),
  ).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`
}
beforeEach(() => {
  nonce = ''
  clientId = 'oaiapp_test'
  identity = {}
  scope = codexScope
  refreshes = 0
  revokeFailure = false
  exchanged = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] })
      if (url.endsWith('/.well-known/openid-configuration'))
        return Response.json({ revocation_endpoint: codexIssuer + '/revoke' })
      if (url.endsWith('/revoke')) return new Response(null, { status: revokeFailure ? 503 : 200 })
      if (url.endsWith('/oauth/token')) {
        exchanged = new URLSearchParams(String(init?.body))
        if (exchanged.get('grant_type') === 'refresh_token') refreshes++
        return Response.json({
          access_token: `access-secret-${refreshes}`,
          refresh_token: `refresh-secret-${refreshes}`,
          id_token: jwt(),
          token_type: 'Bearer',
          expires_in: 3600,
          scope,
        })
      }
      if (url === codexResource + '/models')
        return Response.json({
          models: [
            {
              slug: 'gpt-6.1-sol',
              display_name: '测试订阅模型',
              visibility: 'list',
              context_window: 128000,
            },
            { slug: 'hidden-model', visibility: 'hide' },
          ],
        })
      throw new Error('意外网络请求：' + url)
    }),
  )
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(directory?: string) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), 'antarestra-codex-test-')))
  if (!directory) directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const core = await ctx.plugin(ai, {})
  let subscriptions!: CodexSubscriptions
  const fiber = await ctx.plugin({
    inject: ['ai'],
    async apply(ctx: Context) {
      subscriptions = new CodexSubscriptions(ctx, root)
      await subscriptions.initialize()
    },
  })
  return { ctx, subscriptions, root, fiber, core }
}
function callback(login: CodexLoginView, overrides: Record<string, string> = {}) {
  const auth = new URL(login.url)
  nonce = auth.searchParams.get('nonce')!
  return (
    login.redirectUri +
    '?' +
    new URLSearchParams({
      state: auth.searchParams.get('state')!,
      code: 'one-use-code',
      client_id: clientId,
      ...overrides,
    })
  )
}
async function connect(subscriptions: CodexSubscriptions) {
  const login = await subscriptions.begin('owner')
  await subscriptions.complete('owner', login.id, callback(login))
  return subscriptions.list('owner')[0]!
}
const modelContext = (actorId = 'owner', workspaceId = 'workspace-a') => ({
  actorId,
  workspaceId,
  signal: new AbortController().signal,
})

it('通过真实回环回调完成 PKCE 登录，持久化并注册账户目录，不泄露令牌', async () => {
  const app = await fixture()
  const login = await app.subscriptions.begin('owner')
  const auth = new URL(login.url)
  expect(auth.origin + auth.pathname).toBe(codexIssuer + '/api/accounts/authorize')
  expect(auth.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(auth.searchParams.get('agent_name_hint')).toBe('Antarestra')
  expect(auth.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
  expect(auth.searchParams.get('resource')).toBe(codexResource)
  const invalid = await realFetch(callback(login, { state: 'invalid-state' }))
  expect(invalid.status).toBe(400)
  expect(await invalid.text()).toContain('state')
  expect(exchanged).toBeUndefined()
  const response = await realFetch(callback(login))
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('授权成功')
  expect(exchanged?.get('redirect_uri')).toBe(login.redirectUri)
  expect(exchanged?.get('client_id')).toBe(clientId)
  expect(createHash('sha256').update(exchanged!.get('code_verifier')!).digest('base64url')).toBe(
    auth.searchParams.get('code_challenge'),
  )
  const account = app.subscriptions.list('owner')[0]!
  expect(account.models.map((m) => m.id)).toEqual(['gpt-6.1-sol'])
  expect(JSON.stringify(account)).not.toMatch(
    /access-secret|refresh-secret|idToken|ownerId|subject/,
  )
  expect(app.subscriptions.list('other')).toEqual([])
  expect(() => app.subscriptions.status('other', login.id)).toThrow()
  expect(await app.subscriptions.credential(account.id, modelContext())).toBe('access-secret-0')
  await expect(
    app.subscriptions.credential(account.id, modelContext('other', 'workspace-b')),
  ).rejects.toMatchObject({ status: 403 })
  expect(() => app.subscriptions.complete('owner', login.id, callback(login))).toThrow('已处理')
  if (process.platform !== 'win32')
    expect((await stat(join(app.root, 'accounts.json'))).mode & 0o777).toBe(0o600)
  expect(await readFile(join(app.root, 'accounts.json'), 'utf8')).toContain('refresh-secret-0')
})

it.each(['state', 'nonce', 'aud', 'iss', 'exp', 'scope'])(
  '拒绝不匹配的 %s，失败不覆盖已授权账户',
  async (field) => {
    const app = await fixture()
    const account = await connect(app.subscriptions)
    const login = await app.subscriptions.begin('owner', account.id)
    const url = callback(login)
    if (field === 'state') {
      expect(() =>
        app.subscriptions.complete('owner', login.id, callback(login, { state: 'wrong' })),
      ).toThrow('state')
    } else {
      if (field === 'scope') scope = 'openid profile email'
      else identity[field] = field === 'exp' ? 1 : 'wrong'
      await expect(app.subscriptions.complete('owner', login.id, url)).rejects.toThrow()
    }
    expect(app.subscriptions.list('owner')[0]?.connected).toBe(true)
    expect(await app.subscriptions.credential(account.id, modelContext())).toBe('access-secret-0')
  },
)

it('相同账户并发刷新只交换一次，重启保留注册与主机标识，卸载释放锁与监听', async () => {
  const app = await fixture()
  const account = await connect(app.subscriptions)
  const filename = join(app.root, 'accounts.json')
  const saved = JSON.parse(await readFile(filename, 'utf8')) as CodexState
  saved.accounts[0]!.tokens!.expiresAt = 1
  await app.fiber.dispose()
  await writeFile(filename, JSON.stringify(saved))
  const restored = await fixture(app.root)
  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => restored.subscriptions.credential(account.id, modelContext())),
  )
  expect(tokens).toEqual(Array(5).fill('access-secret-1'))
  expect(refreshes).toBe(1)
  const next = JSON.parse(await readFile(filename, 'utf8')) as CodexState
  expect(next.accounts[0]!.tokens!.refreshToken).toBe('refresh-secret-1')
  const login = await restored.subscriptions.begin('owner', account.id)
  const auth = new URL(login.url)
  expect(auth.searchParams.get('client_id')).toBe(clientId)
  expect(auth.searchParams.get('agent_name_hint')).toBeNull()
  expect(auth.searchParams.get('ext_agent_host_id')).toBe(saved.hostId)
  const competing = new CodexStorage(app.root)
  await expect(competing.lock()).rejects.toThrow('正在使用')
  await restored.fiber.dispose()
  await expect(realFetch(login.redirectUri)).rejects.toThrow()
  await expect(stat(join(app.root, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('拒绝跨账户回调、错误客户端及用户拒绝授权，取消会关闭回环端口', async () => {
  const app = await fixture()
  const account = await connect(app.subscriptions)
  const login = await app.subscriptions.begin('owner', account.id)
  expect(() => app.subscriptions.complete('other', login.id, callback(login))).toThrow()
  await expect(
    app.subscriptions.complete('owner', login.id, callback(login, { client_id: 'oaiapp_other' })),
  ).rejects.toThrow('客户端 ID')
  const denied = await app.subscriptions.begin('owner')
  await expect(
    app.subscriptions.complete('owner', denied.id, callback(denied, { error: 'access_denied' })),
  ).rejects.toThrow('拒绝')
  const cancelled = await app.subscriptions.begin('owner')
  await app.subscriptions.cancel('owner', cancelled.id)
  await expect(realFetch(cancelled.redirectUri)).rejects.toThrow()
  expect(app.subscriptions.list('owner')).toHaveLength(1)
})

it.each([false, true])(
  '断开停止凭据使用并保留注册，远端撤销失败=%s 时明确提示',
  async (failure) => {
    const app = await fixture()
    const account = await connect(app.subscriptions)
    revokeFailure = failure
    await expect(app.subscriptions.disconnect('other', account.id)).rejects.toThrow('不存在')
    const result = await app.subscriptions.disconnect('owner', account.id)
    expect(result.revoked).toBe(!failure)
    if (failure) expect(result.message).toContain('未确认远端撤销')
    expect(app.subscriptions.list('owner')[0]).toMatchObject({ connected: false, clientId })
    const stored = await readFile(join(app.root, 'accounts.json'), 'utf8')
    expect(stored).not.toMatch(/access-secret|refresh-secret|idToken/)
    await expect(app.subscriptions.credential(account.id, modelContext())).rejects.toThrow('已断开')
  },
)

it('官方订阅请求约束保留工具历史，移除不支持参数并使用命名空间', () => {
  const result = subscriptionPayload({
    model: 'test',
    store: true,
    stream: false,
    max_output_tokens: 10,
    temperature: 0.5,
    previous_response_id: 'old',
    input: [
      { role: 'system', content: '指令' },
      { type: 'function_call', name: 'tool', call_id: 'call' },
    ],
    tools: [{ type: 'function', name: 'tool', parameters: {} }],
  })
  expect(result).toMatchObject({
    store: false,
    stream: true,
    input: [{ role: 'developer' }, { namespace: 'antarestra' }],
    tools: [{ type: 'namespace', name: 'antarestra' }],
  })
  expect(result).not.toHaveProperty('max_output_tokens')
  expect(result).not.toHaveProperty('temperature')
  expect(result).not.toHaveProperty('previous_response_id')
})

it('管理接口需要控制台与订阅权限，账户列表按登录主体隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'antarestra-codex-http-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(ai, {})
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  await ctx.plugin(WebUI)
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'test-codex-password-42',
  })
  await ctx.plugin(provider, { codexCredentialsDirectory: root })
  const base = `http://127.0.0.1:${ctx.server.address!.port}/api`
  expect((await realFetch(base + '/codex-subscription')).status).toBe(401)
  const response = await realFetch(base + '/auth/local/local/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'test-codex-password-42' }),
  })
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  const list = await realFetch(base + '/codex-subscription', { headers: { Cookie: cookie } })
  expect(list.status).toBe(200)
  expect(list.headers.get('cache-control')).toBe('no-store')
  expect(await list.json()).toEqual([])
})

it.each(['completed', 'failed', 'interrupted'])(
  '订阅驱动通过真实 SSE 解析 %s 响应，只接受完成事件',
  async (terminal) => {
    const { driver } = await import('../../plugins/features/ai-provider/src/driver.js')
    const { codexProvider } = await import('../../plugins/features/ai-provider/src/codex-models.js')
    let sent: Record<string, unknown> | undefined
    const message = {
      id: 'message',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '订阅测试完成', annotations: [] }],
    }
    const call = {
      type: 'function_call',
      id: 'fc-test',
      call_id: 'call-test',
      name: 'lookup',
      namespace: 'antarestra',
      arguments: '{"query":"test"}',
      status: 'completed',
    }
    const events = [
      { type: 'response.created', response: { id: 'response-test', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: message },
      { type: 'response.output_text.delta', output_index: 0, delta: '订阅测试完成' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.output_item.added', output_index: 1, item: call },
      { type: 'response.output_item.done', output_index: 1, item: call },
      ...(terminal === 'interrupted'
        ? []
        : [
            {
              type: `response.${terminal}`,
              response: {
                id: 'response-test',
                status: terminal,
                output: [message, call],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                ...(terminal === 'failed'
                  ? {
                      error: {
                        code: 'subscription_sharing_usage_limit_exceeded',
                        message: '订阅用量已达到上限',
                      },
                    }
                  : {}),
              },
            },
          ]),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(codexResource + '/responses')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-secret')
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )
    const model = {
      id: 'test-model',
      title: '订阅测试',
      contextWindow: 128000,
      maxOutputTokens: 4000,
      input: ['text', 'image'] as ('text' | 'image')[],
      output: ['text'] as 'text'[],
      thinkingLevels: [],
      tools: true,
    }
    const record = codexProvider({
      id: 'codex-test',
      ownerId: 'owner',
      clientId,
      subject: 'subject',
      email: 'test@example.com',
      models: [model],
    })
    const generate = driver(record).generate(
      {
        model: { providerId: record.id, modelId: model.id },
        thinking: null,
        parameters: {},
        systemPrompt: '测试系统提示词',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '测试输入' },
              { type: 'image', resourceId: 'image', mimeType: 'image/png' },
            ],
          },
        ],
        tools: [
          {
            id: 'lookup',
            description: '查询',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
      {
        baseUrl: codexResource,
        credential: 'access-secret',
        resources: new Map([
          ['image', { data: 'aW1hZ2U=', mimeType: 'image/png', filename: '测试.png' }],
        ]),
      },
      modelContext(),
      async () => {},
    )
    if (terminal === 'completed') {
      const result = await generate
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: 'text', text: '订阅测试完成' }),
      )
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: 'tool-call',
          name: 'lookup',
          arguments: { query: 'test' },
        }),
      )
    } else await expect(generate).rejects.toThrow()
    expect(sent).toMatchObject({
      store: false,
      stream: true,
      tools: [{ type: 'namespace', name: 'antarestra' }],
    })
    expect(sent).not.toHaveProperty('max_output_tokens')
    expect(JSON.stringify(sent)).toContain('data:image/png;base64,aW1hZ2U=')
  },
)

it('取消排队的模型凭据请求无需等待目录同步，卸载中止在途网络并移除提供商', async () => {
  const app = await fixture()
  const account = await connect(app.subscriptions)
  app.ctx.rbac.registerRequestSource(app.ctx, 'codex-test', {
    id: 'codex-test',
    resolve: async () => ({ actorId: 'owner', workspaceId: 'space', roles: ['user'] }),
  })
  const access = await app.ctx.ai.authorize('codex-test', {})
  expect((await app.ctx.ai.catalog(access)).providers.some((item) => item.id === account.id)).toBe(
    true,
  )
  const started = Promise.withResolvers<void>()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          started.resolve()
          init?.signal?.addEventListener('abort', () => reject(new Error('请求已取消')), {
            once: true,
          })
        }),
    ),
  )
  const syncing = app.subscriptions.sync('owner', account.id)
  const syncResult = syncing.catch(() => {})
  await started.promise
  const controller = new AbortController()
  const pending = app.subscriptions.credential(account.id, {
    ...modelContext(),
    signal: controller.signal,
  })
  controller.abort(new Error('测试取消'))
  await expect(pending).rejects.toThrow('测试取消')
  await app.fiber.dispose()
  await syncResult
  expect((await app.ctx.ai.catalog(access)).providers.some((item) => item.id === account.id)).toBe(
    false,
  )
})

it('AI 依赖卸载时关闭待登录端口并释放凭据目录', async () => {
  const app = await fixture()
  const login = await app.subscriptions.begin('owner')
  const instance = app.subscriptions
  await app.core.dispose()
  await expect(realFetch(login.redirectUri)).rejects.toThrow()
  await expect(stat(join(app.root, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(instance.begin('owner')).rejects.toThrow()
})
