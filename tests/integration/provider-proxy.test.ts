import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createTcpServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { generate } from 'selfsigned'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { providerNetwork } from '../../plugins/features/ai-provider/src/network.js'
import { validateProvider } from '../../plugins/features/ai-provider/src/validation.js'
import { discover } from '../../plugins/features/ai-provider/src/catalog.js'
import { driver as providerDriver } from '../../plugins/features/ai-provider/src/driver.js'
import { listenForTest } from '../../scripts/test-listen.js'

const networks: ReturnType<typeof providerNetwork>[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()
const certificates = getCACertificates('default')
let certificate: Awaited<ReturnType<typeof generate>>

beforeAll(async () => {
  certificate = await generate([{ name: 'commonName', value: 'proxy-only.invalid' }], {
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'proxy-only.invalid' }] },
    ],
  })
})

async function listen(server: Server) {
  servers.push(server)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return listenForTest(server)
}

function network(proxy?: string) {
  const client = providerNetwork(proxy)
  networks.push(client)
  return client
}

afterEach(async () => {
  for (const client of networks.splice(0)) await client.dispose()
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  setDefaultCACertificates(certificates)
})

async function proxyServer(protocol: string, origin: number) {
  const destinations: string[] = []
  function tunnel(socket: Socket, head: Buffer, ready: () => void) {
    const remote = connect(origin, '127.0.0.1', () => {
      ready()
      remote.write(head)
      socket.pipe(remote).pipe(socket)
    })
    socket.on('close', () => remote.destroy())
    remote.on('error', () => socket.destroy())
  }
  const server =
    protocol === 'http'
      ? createServer().on('connect', (request, socket, head) => {
          destinations.push(request.url!)
          tunnel(socket as Socket, head, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          })
        })
      : createTcpServer((socket) => {
          let pending = Buffer.alloc(0)
          let greeted = false
          const receive = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk])
            if (!greeted) {
              if (pending.length < 2 || pending.length < 2 + pending[1]!) return
              pending = pending.subarray(2 + pending[1]!)
              greeted = true
              socket.write(Buffer.from([5, 0]))
            }
            if (pending.length < 5) return
            expect(pending[3]).toBe(3)
            const size = pending[4]!
            if (pending.length < 5 + size + 2) return
            destinations.push(
              pending.subarray(5, 5 + size).toString() + ':' + pending.readUInt16BE(5 + size),
            )
            socket.off('data', receive)
            tunnel(socket, pending.subarray(5 + size + 2), () => {
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            })
          }
          socket.on('data', receive)
        })
  const port = await listen(server)
  return { url: `${protocol}://127.0.0.1:${port}`, destinations }
}

it.each(['http', 'socks5'])('通过 %s 代理完成 HTTPS 流式请求并回收连接', async (protocol) => {
  setDefaultCACertificates([...certificates, certificate.cert])
  const origin = await listen(
    createHttpsServer({ key: certificate.private, cert: certificate.cert }, async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      expect(req.headers.authorization).toBe('Bearer test-token')
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
        stream: true,
        store: false,
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const message = {
        id: 'message',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '代理模型响应', annotations: [] }],
      }
      const events = [
        { type: 'response.created', response: { id: 'response', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: message },
        { type: 'response.output_text.delta', output_index: 0, delta: '代理模型响应' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: {
            id: 'response',
            status: 'completed',
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    }),
  )
  const proxy = await proxyServer(protocol, origin)
  const client = network(proxy.url)
  const directPort = await listen(createServer((_req, res) => res.end('直连')))
  const baseUrl = `https://proxy-only.invalid:${origin}`
  const driver = providerDriver(
    {
      id: 'proxy-test',
      name: '代理测试',
      note: '',
      apiKey: 'test-token',
      revision: 1,
      builtin: '',
      api: 'openai-responses',
      baseUrl,
      headers: {},
      models: [
        {
          id: 'test-model',
          title: '代理测试',
          contextWindow: 128000,
          maxOutputTokens: 4000,
          input: ['text'],
          output: ['text'],
          tools: true,
          thinkingLevels: [],
        },
      ],
    },
    undefined,
    client,
  )
  const [response, direct] = await Promise.all([
    driver.generate(
      {
        model: { providerId: 'proxy-test', modelId: 'test-model' },
        thinking: null,
        parameters: {},
        systemPrompt: '',
        messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
        tools: [],
      },
      { baseUrl, credential: 'test-token' },
      {
        actorId: 'owner',
        workspaceId: 'workspace',
        signal: AbortSignal.timeout(3000),
      },
      async () => {},
    ),
    fetch(`http://127.0.0.1:${directPort}`),
  ])
  expect(response.content).toContainEqual(
    expect.objectContaining({ type: 'text', text: '代理模型响应' }),
  )
  expect(await direct.text()).toBe('直连')
  expect(proxy.destinations).toEqual([`proxy-only.invalid:${origin}`])
  await client.dispose()
  expect(() => client.fetch(`https://proxy-only.invalid:${origin}`)).toThrow('已卸载')
  await expect.poll(() => sockets.size).toBeLessThanOrEqual(1)
})

it.each(['http', 'socks5'])('通过 %s 代理的在途请求响应取消及卸载', async (protocol) => {
  const origin = await listen(createServer(() => {}))
  const proxy = await proxyServer(protocol, origin)
  // HTTPS 握手停在本地无响应服务上，覆盖连接尚未建立完毕时的取消。
  const client = network(proxy.url)
  const controller = new AbortController()
  const first = expect(
    client.fetch(`https://proxy-only.invalid:${origin}`, { signal: controller.signal }),
  ).rejects.toThrow()
  await expect.poll(() => proxy.destinations.length).toBe(1)
  controller.abort()
  await first
  const pending = expect(client.fetch(`https://proxy-only.invalid:${origin}`)).rejects.toThrow()
  await expect.poll(() => proxy.destinations.length).toBe(2)
  await client.dispose()
  await pending
  await expect.poll(() => sockets.size).toBe(0)
})

it.each(['http', 'socks5'])('代理 %s 不可用时不回退直连', async (protocol) => {
  let hits = 0
  const origin = await listen(
    createServer((_req, res) => {
      hits++
      res.end('不应直连')
    }),
  )
  const proxy = createTcpServer((socket) => socket.destroy())
  const port = await listen(proxy)
  const client = network(`${protocol}://127.0.0.1:${port}`)
  await expect(
    client.fetch(`http://127.0.0.1:${origin}`, {
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow()
  expect(hits).toBe(0)
})

it.each([
  'not-a-url',
  'ftp://user:secret@localhost',
  'http://localhost/path',
  'socks4://localhost',
])('拒绝无效代理配置且错误不泄露地址：%s', (proxy) => {
  expect(() =>
    validateProvider({
      id: 'test',
      name: '测试',
      note: '',
      builtin: '',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid',
      headers: {},
      proxy,
    }),
  ).toThrow('代理服务器需为')
  expect(() =>
    validateProvider({
      id: 'test',
      name: '测试',
      note: '',
      builtin: '',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid',
      headers: {},
      proxy,
    }),
  ).not.toThrow(proxy)
})

it.each([undefined, '', '  '])('未配置代理时保持直连：%s', async (proxy) => {
  const port = await listen(createServer((_req, res) => res.end('直连成功')))
  expect(await (await network(proxy).fetch(`http://127.0.0.1:${port}`)).text()).toBe('直连成功')
})

const model = {
  id: 'test-model',
  title: '代理测试',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  input: ['text'] as const,
  output: ['text'] as const,
  tools: true,
  thinkingLevels: [],
}
function record(api: string, baseUrl: string, proxy: string) {
  return {
    ...validateProvider({
      id: api,
      name: '测试',
      note: '',
      builtin: '',
      api,
      baseUrl,
      proxy,
      headers: {},
      apiKey: 'test-token',
    }),
    models: [{ ...model, input: ['text'] as ['text'], output: ['text'] as ['text'] }],
  }
}
function generateModel(
  provider: ReturnType<typeof record>,
  client: ReturnType<typeof network>,
  signal = AbortSignal.timeout(5000),
) {
  return providerDriver(provider, undefined, client).generate(
    {
      model: { providerId: provider.id, modelId: model.id },
      thinking: null,
      parameters: {},
      systemPrompt: '',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: '测试' }] }],
    },
    { baseUrl: provider.baseUrl, credential: provider.apiKey },
    { actorId: 'owner', workspaceId: 'space', signal },
    async () => {},
  )
}

it.each(['http', 'socks5'])(
  '不同提供商并发使用各自 %s 代理同步目录，直连请求保持独立',
  async (protocol) => {
    const apps = await Promise.all(
      ['first', 'second'].map(async (id) => {
        const origin = await listen(
          createServer((_req, res) => res.end(JSON.stringify({ data: [{ id }] }))),
        )
        const proxy = await proxyServer(protocol, origin)
        const client = network(proxy.url)
        return {
          client,
          proxy,
          provider: record('openai-completions', 'http://proxy-only.invalid/v1', proxy.url),
        }
      }),
    )
    const results = await Promise.all(
      apps.map(({ provider, client }) =>
        discover(provider, AbortSignal.timeout(3000), client.fetch),
      ),
    )
    expect(results.map((result) => result.models[0]?.id)).toEqual(['first', 'second'])
    expect(results.map((result) => result.warning)).toEqual(['', ''])
    for (const app of apps) expect(app.proxy.destinations).toEqual(['proxy-only.invalid:80'])
    await apps[0]!.client.dispose()
    expect(
      (await discover(apps[1]!.provider, AbortSignal.timeout(3000), apps[1]!.client.fetch))
        .models[0]?.id,
    ).toBe('second')
  },
)

it.each(
  ['google-generative-ai', 'google-vertex'].flatMap((api) =>
    ['http', 'socks5'].map((protocol) => ({ api, protocol })),
  ),
)('$api 经 $protocol 代理接收流式响应，保留上游路径并回收本机通道', async ({ api, protocol }) => {
  const urls: string[] = []
  const origin = await listen(
    createServer(async (req, res) => {
      urls.push(req.url!)
      for await (const _chunk of req) {
        /* 消费 SDK 请求体。 */
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '代理成功' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`,
      )
    }),
  )
  const proxy = await proxyServer(protocol, origin)
  const client = network(proxy.url)
  const provider = record(api, 'http://proxy-only.invalid/v1beta', proxy.url)
  expect((await generateModel(provider, client)).content).toEqual([
    { type: 'text', text: '代理成功' },
  ])
  expect(urls).toEqual([
    `/v1beta/${api === 'google-vertex' ? 'publishers/google/' : ''}models/test-model:streamGenerateContent?alt=sse`,
  ])
  expect(proxy.destinations).toEqual(['proxy-only.invalid:80'])
  const local = await client.requestBaseUrl(api, provider.baseUrl)
  await client.dispose()
  await expect(fetch(local)).rejects.toThrow()
  await expect.poll(() => sockets.size).toBe(0)
})

it.each(['http', 'socks5'])('Bedrock 经 %s 代理发送请求，不忽略独立代理配置', async (protocol) => {
  const urls: string[] = []
  const origin = await listen(
    createServer(async (req, res) => {
      urls.push(req.url!)
      for await (const _chunk of req) {
        /* 消费 SDK 请求体。 */
      }
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ message: '本地模拟拒绝' }))
    }),
  )
  const proxy = await proxyServer(protocol, origin)
  const client = network(proxy.url)
  await expect(
    generateModel(
      record('bedrock-converse-stream', 'http://proxy-only.invalid', proxy.url),
      client,
    ),
  ).rejects.toThrow()
  expect(urls).toEqual(['/model/test-model/converse-stream'])
  expect(proxy.destinations).toEqual(['proxy-only.invalid:80'])
})
