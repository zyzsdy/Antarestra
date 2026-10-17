import { createServer } from 'node:http'
import type { RequestListener } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { RequestSnapshot } from '@antarestra/ai'
import { candidates } from '../../plugins/features/ai-provider/src/catalog.js'
import { driver, resolveModel } from '../../plugins/features/ai-provider/src/driver.js'
import {
  validateModel,
  validateProvider,
} from '../../plugins/features/ai-provider/src/validation.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(kind: string, handler: RequestListener) {
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
  const localUrl = `http://127.0.0.1:${address.port}`
  const opencode = kind === 'opencode-go'
  const record = validateProvider({
    id: kind,
    name: 'Google 请求测试',
    note: '',
    builtin: opencode ? kind : '',
    api: opencode ? 'anthropic-messages' : kind,
    baseUrl: opencode ? 'https://opencode.ai/inference/go' : localUrl,
    apiKey: 'test-key',
    headers: {},
  })
  const modelId = 'gemini-4-argon-contributor'
  record.models = [
    validateModel(
      opencode
        ? candidates(record).find((model) => model.id === modelId)
        : {
            id: modelId,
            title: '测试模型',
            contextWindow: 8192,
            maxOutputTokens: 1024,
            input: ['text'],
            output: ['text'],
            tools: true,
            thinkingLevels: [],
          },
    ),
  ]
  const resolved = resolveModel(record, record.models[0]!, record.baseUrl)
  expect(resolved.api).toBe(opencode ? 'google-generative-ai' : kind)
  // 保留真实内置适配器和官方 URL 选择，仅把 HTTP 传输重定向到本地模拟服务。
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url)
    urls.push(target.href)
    expect(target.origin).toBe(new URL(resolved.baseUrl).origin)
    return originalFetch(`${localUrl}${target.pathname}${target.search}`, init)
  })
  const controller = new AbortController()
  const request: RequestSnapshot = {
    model: { providerId: record.id, modelId },
    thinking: opencode ? 'low' : null,
    parameters: {},
    systemPrompt: '',
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
  }
  const pdf = { filename: '说明.pdf', mimeType: 'application/pdf', data: 'aGVsbG8=' }
  return {
    request,
    controller,
    urls,
    pdf,
    generate: () =>
      driver(record).generate(
        request,
        {
          baseUrl: record.baseUrl,
          credential: 'test-key',
          resources: new Map([['pdf', pdf]]),
        },
        {
          actorId: 'test',
          workspaceId: 'test',
          conversationId: 'google-test',
          signal: controller.signal,
        },
        async () => {},
      ),
  }
}

it.each(
  ['opencode-go', 'google-generative-ai', 'google-vertex'].flatMap((kind) =>
    [false, true].map((attached) => ({ kind, attached })),
  ),
)('$kind 驱动收到完整 Google 流式响应（包含 PDF：$attached）', async ({ kind, attached }) => {
  const received: { url: string; session: string | string[] | undefined; body: unknown }[] = []
  const app = await fixture(kind, async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    received.push({
      url: req.url!,
      session: req.headers['x-opencode-session'],
      body: JSON.parse(body),
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({
        candidates: [
          { content: { role: 'model', parts: [{ text: '测试成功' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      })}\n\n`,
    )
  })
  if (attached)
    app.request.messages[0]!.content.push({
      type: 'file',
      resourceId: 'pdf',
      mimeType: app.pdf.mimeType,
    })
  const result = await app.generate()
  expect(result.content).toEqual([{ type: 'text', text: '测试成功' }])
  expect(result.stopReason).toBe('stop')
  expect(result.usage?.totalTokens).toBe(5)
  expect(received).toHaveLength(1)
  expect(received[0]!.url).toContain('gemini-4-argon-contributor:streamGenerateContent')
  expect(received[0]!.body).toMatchObject({
    contents: [
      {
        role: 'user',
        parts: [
          { text: '测试' },
          ...(attached ? [{ inlineData: { mimeType: app.pdf.mimeType, data: app.pdf.data } }] : []),
        ],
      },
    ],
  })
  if (kind === 'opencode-go') {
    expect(app.urls[0]).toMatch(/^https:\/\/opencode\.ai\/inference\/go\/v1\/models\//)
    expect(received[0]!.session).toBe('google-test')
  }
})

it.each(['opencode-go', 'google-vertex'])(
  '%s 取消运行会中断正在等待响应的 HTTP 请求',
  async (kind) => {
    const disconnected = Promise.withResolvers<void>()
    const app = await fixture(kind, (req, res) => {
      req.resume()
      res.on('close', () => disconnected.resolve())
      app.controller.abort(new Error('测试取消'))
    })
    await expect(app.generate()).rejects.toMatchObject({ code: 'provider_request_failed' })
    expect(app.urls).toHaveLength(1)
    expect(app.controller.signal.aborted).toBe(true)
    await disconnected.promise
  },
)
