import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { normalizeProxy } from './proxy.js'

// 代理与 Fetch 使用同一版 Undici，避免 Node 内置 dispatcher 协议差异。
const proxyFetch = undiciFetch as unknown as typeof globalThis.fetch

/** 每个提供商注册独立持有连接池；更新、删除及卸载时取消请求并等待回收。 */
export function providerNetwork(proxy?: string) {
  proxy = normalizeProxy(proxy ?? '')
  const dispatcher = proxy ? new ProxyAgent({ uri: proxy, proxyTunnel: true }) : undefined
  const stopped = new AbortController()
  const routes = new Map<string, string>()
  const pending = new Set<Promise<void>>()
  // Google / Bedrock SDK 不提供 Fetch 注入：仅监听回环地址，以不可猜路径固定上游。
  // 不接受客户端指定目标，不暴露通用转发端点。
  const relay = createServer((req, res) => {
    const request = forward()
    pending.add(request)
    void request.finally(() => pending.delete(request))
    async function forward() {
      const controller = new AbortController()
      res.once('close', () => controller.abort())
      try {
        const path = req.url ?? ''
        const separator = path.indexOf('/', 1)
        const origin = routes.get(path.slice(1, separator))
        if (!origin) {
          res.writeHead(404).end()
          return
        }
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const init = {
          method: req.method ?? 'POST',
          headers,
          signal: controller.signal,
          redirect: 'error' as const,
          ...(!['GET', 'HEAD'].includes(req.method ?? '')
            ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
            : {}),
        }
        const response = await fetch(origin + path.slice(separator), init)
        res.statusCode = response.status
        for (const [key, value] of response.headers) {
          if (
            !['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(key)
          )
            res.setHeader(key, value)
        }
        if (response.body)
          await pipeline(
            Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
            res,
          )
        else res.end()
      } catch {
        if (!res.headersSent) res.writeHead(502).end('提供商代理请求失败')
        else res.destroy()
      }
    }
  })
  let listening: Promise<number> | undefined
  const fetch: typeof globalThis.fetch = (input, init) => {
    stopped.signal.throwIfAborted()
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    return (dispatcher ? proxyFetch : globalThis.fetch)(input, {
      ...init,
      signal: AbortSignal.any([stopped.signal, ...(signal ? [signal] : [])]),
      ...(dispatcher ? { dispatcher } : {}),
    })
  }
  return {
    fetch,
    async requestBaseUrl(api: string, baseUrl: string) {
      if (
        !dispatcher ||
        !['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(api)
      )
        return baseUrl
      stopped.signal.throwIfAborted()
      listening ??= new Promise<number>((resolve, reject) => {
        relay.once('error', reject)
        relay.listen(0, '127.0.0.1', () => {
          const address = relay.address()
          if (!address || typeof address === 'string')
            return reject(new Error('提供商转发通道启动失败'))
          resolve(address.port)
        })
      })
      const port = await listening
      stopped.signal.throwIfAborted()
      const url = new URL(baseUrl)
      let token = [...routes].find(([, origin]) => origin === url.origin)?.[0]
      if (!token) {
        token = randomUUID()
        routes.set(token, url.origin)
      }
      const path = url.pathname === '/' && !baseUrl.endsWith('/') ? '' : url.pathname
      return `http://127.0.0.1:${port}/${token}${path}${url.search}`
    },
    async dispose() {
      stopped.abort(new Error('提供商网络已卸载'))
      if (listening) {
        await listening.catch(() => {})
        await new Promise<void>((resolve) => {
          relay.close(() => resolve())
          relay.closeAllConnections()
        })
      }
      await dispatcher?.destroy()
      await Promise.allSettled([...pending])
      routes.clear()
    },
  }
}
