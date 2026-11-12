import type { Context } from '@antarestra/plugin-sdk'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

// Web Fetch 接口相同；Undici 的类型声明与 DOM 的 Request/Response 分别维护。
const proxyFetch = undiciFetch as unknown as typeof globalThis.fetch

/** 每个插件实例独立管理连接；代理失败时不回退直连。 */
export function codexFetch(ctx: Context, proxy?: string): typeof globalThis.fetch {
  let dispatcher: ProxyAgent | undefined
  if (proxy?.trim()) {
    try {
      const url = new URL(proxy.trim())
      if (
        !['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) ||
        !url.hostname ||
        (url.pathname && url.pathname !== '/') ||
        url.search ||
        url.hash
      )
        throw new Error()
      dispatcher = new ProxyAgent(url.href)
    } catch {
      // 地址可能包含代理凭据，不将原始配置或底层错误写入日志。
      throw new Error('订阅代理地址无效，请使用 HTTP、HTTPS 或 SOCKS5 代理地址')
    }
  }
  const stopped = new AbortController()
  ctx.effect(() => async () => {
    stopped.abort(new Error('订阅网络已卸载'))
    await dispatcher?.destroy()
  })
  return (input, init) => {
    stopped.signal.throwIfAborted()
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const options = {
      ...init,
      signal: AbortSignal.any([stopped.signal, ...(signal ? [signal] : [])]),
      ...(dispatcher ? { dispatcher } : {}),
    }
    // 代理和 Fetch 必须来自同一版 Undici，Node 内置版本的 dispatcher 协议可能不同。
    return (dispatcher ? proxyFetch : globalThis.fetch)(input, options)
  }
}
