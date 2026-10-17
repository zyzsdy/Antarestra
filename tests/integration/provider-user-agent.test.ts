import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { arch, platform, release } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { applicationUserAgent } from '@antarestra/plugin-sdk'
import type { RequestSnapshot, RunContext } from '@antarestra/ai'
import { driver, resolveModel } from '../../plugins/features/ai-provider/src/driver.js'
import { providerRequestHeaders } from '../../plugins/features/ai-provider/src/user-agent.js'
import { validateProvider } from '../../plugins/features/ai-provider/src/validation.js'
import type { ProviderStreams } from '../../plugins/features/ai-provider/node_modules/@earendil-works/pi-ai/dist/types.js'
import { normalizeContext } from '../../plugins/features/ai-provider/node_modules/@earendil-works/pi-ai/dist/index.js'

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }
const expectedUserAgent = `pi (${platform()} ${release()}; ${arch()}) Anta/${version}`
const definition = {
  id: 'test-model',
  title: '测试模型',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  input: ['text'] as const,
  output: ['text'] as const,
  tools: true,
  thinkingLevels: [],
}
function provider(api: string, baseUrl = 'https://example.invalid/v1') {
  const record = validateProvider({
    id: 'ua-test',
    name: '请求头测试',
    note: '',
    builtin: '',
    api,
    baseUrl,
    apiKey: 'test-key',
    headers: { 'x-test': 'preserved' },
  })
  record.models = [{ ...definition, input: ['text'], output: ['text'] }]
  return record
}
const piApis = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
]

it('应用标识读取根 package.json 中的版本', () => {
  expect(applicationUserAgent()).toBe(`Anta/${version}`)
})
it.each(piApis)('%s 默认 pi UA 仅追加一次应用版本', (api) => {
  const record = provider(api)
  const model = resolveModel(record, record.models[0]!, record.baseUrl)
  const headers = providerRequestHeaders(model, 'test-key', record.headers)
  expect(headers).toEqual({ 'User-Agent': expectedUserAgent, 'x-test': 'preserved' })
  expect(providerRequestHeaders(model, 'test-key', headers)).toEqual(headers)
  expect(record.headers).toEqual({ 'x-test': 'preserved' })
})
it.each(['User-Agent', 'user-agent', 'uSeR-aGeNt'])(
  '保留自定义 %s，不追加版本且不产生重复请求头',
  (name) => {
    const record = provider('openai-completions')
    const model = resolveModel(record, record.models[0]!, record.baseUrl)
    const headers = { ...record.headers, [name]: 'CustomClient/1.0' }
    expect(providerRequestHeaders(model, 'test-key', headers)).toEqual({
      ...record.headers,
      'User-Agent': 'CustomClient/1.0',
    })
    expect(
      providerRequestHeaders({ ...model, headers: { [name]: 'ModelClient/1.0' } }, 'test-key', {}),
    ).toEqual({})
  },
)
it.each(['bedrock-converse-stream', 'pi-messages', 'anthropic-messages'])(
  '%s 特殊 UA 交由原有适配器生成',
  (api) => {
    const record = provider(api)
    const model = resolveModel(record, record.models[0]!, record.baseUrl)
    expect(providerRequestHeaders(model, 'sk-ant-oat-test', record.headers)).toEqual(record.headers)
  },
)

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const request: RequestSnapshot = {
  model: { providerId: 'ua-test', modelId: definition.id },
  thinking: null,
  parameters: {},
  systemPrompt: '',
  messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
  tools: [],
}
const context: RunContext = {
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
    defaultModel: request.model,
    toolIds: [],
    skillIds: [],
    extensions: {},
  },
}

const httpApis = piApis.filter((api) => api !== 'openai-codex-responses')
it.each(
  httpApis.flatMap((api) =>
    [undefined, 'User-Agent', 'user-agent', 'uSeR-aGeNt'].map((header) => ({ api, header })),
  ),
)('本地接收 $api 的实际 HTTP 请求头，自定义键为 $header', async ({ api, header }) => {
  const received: string[] = []
  const server = createServer((req, res) => {
    received.push(req.headers['user-agent'] ?? '')
    req.resume()
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '测试结束', status: 'INVALID_ARGUMENT' } }))
  })
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
  const baseUrl = `http://127.0.0.1:${address.port}`
  const record = provider(api, baseUrl)
  if (header) record.headers[header] = 'CustomClient/1.0'
  if (api === 'google-generative-ai' || api === 'google-vertex') {
    // 独立验证 Google 适配器；现有附件转换会破坏 AbortSignal，与 UA 无关。
    const adapter: ProviderStreams =
      api === 'google-generative-ai'
        ? await import('../../plugins/features/ai-provider/node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js')
        : await import('../../plugins/features/ai-provider/node_modules/@earendil-works/pi-ai/dist/api/google-vertex.js')
    const model = resolveModel(record, record.models[0]!, baseUrl)
    const stream = adapter.streamSimple(
      model,
      normalizeContext({ messages: [{ role: 'user', content: '测试', timestamp: 0 }] }),
      {
        apiKey: 'test-key',
        headers: providerRequestHeaders(model, 'test-key', record.headers),
        signal: context.signal,
        maxRetries: 0,
        env: {},
      },
    )
    expect((await stream.result()).stopReason).toBe('error')
  } else {
    await expect(
      driver(record).generate(
        request,
        { baseUrl, credential: 'test-key' },
        context,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'provider_request_failed' })
  }
  expect(received).toEqual([header ? 'CustomClient/1.0' : expectedUserAgent])
  if (api === 'anthropic-messages') {
    received.length = 0
    await expect(
      driver(record).generate(
        request,
        { baseUrl, credential: 'sk-ant-oat-test' },
        context,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'provider_request_failed' })
    expect(received).toEqual([
      header ? 'CustomClient/1.0' : expect.stringMatching(/^claude-cli\/[\d.]+$/),
    ])
  }
})
