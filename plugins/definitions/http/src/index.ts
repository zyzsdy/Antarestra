import { Http } from '@cordisjs/plugin-http'
import type { Context, Fiber } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import * as undici from 'undici'

export { Http }
export const name = 'http'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    http: Http
  }
}

/** 固定使用同一份 Undici，避免 --expose-internals 切换到缺少 SOCKS5 的内置版本。 */
class HttpService extends Http {
  constructor(
    ctx: Context,
    private stopped: AbortSignal,
    private owners: WeakMap<Fiber, AbortController>,
  ) {
    super(ctx)
  }

  override resolveConfig(init?: Http.RequestConfig): Http.RequestConfig {
    this.stopped.throwIfAborted()
    const fiber = this.ctx.fiber
    fiber.assertActive()
    let owner = this.owners.get(fiber)
    if (!owner) {
      owner = new AbortController()
      const controller = owner
      this.ctx.effect(() => () => {
        controller.abort(new Error('HTTP 调用方已卸载'))
        this.owners.delete(fiber)
      })
      this.owners.set(fiber, owner)
    }
    const config = super.resolveConfig(init)
    return {
      ...config,
      signal: AbortSignal.any([
        this.stopped,
        owner.signal,
        ...(config.signal ? [config.signal] : []),
      ]),
    }
  }
  override get undici() {
    return undici
  }
}

export function apply(ctx: Context, config: Record<string, never> = {}) {
  schemaConfig(new URL('../config.schema.json', import.meta.url), config)
  const direct = new undici.Agent()
  const proxies = new Map<string, undici.ProxyAgent>()
  const stopped = new AbortController()
  const owners = new WeakMap<Fiber, AbortController>()
  ctx.effect(() => async () => {
    stopped.abort(new Error('HTTP 服务已卸载'))
    await Promise.all([direct.destroy(), ...[...proxies.values()].map((agent) => agent.destroy())])
    proxies.clear()
  })
  const http = new HttpService(ctx, stopped.signal, owners)
  http.proxy(['http', 'https', 'socks', 'socks5'], (url) => {
    stopped.signal.throwIfAborted()
    let agent = proxies.get(url.href)
    if (!agent) {
      agent = new undici.ProxyAgent(url.href)
      proxies.set(url.href, agent)
    }
    return agent
  })
  ctx.on(
    'http/fetch',
    async function (_url, init, _config, next) {
      stopped.signal.throwIfAborted()
      // 显式使用独立直连池，不读取环境代理，也不修改全局 dispatcher。
      init.dispatcher ??= direct
      return next()
    },
    { prepend: true },
  )
  ctx.on('http/websocket', (_url, init, _config, next) => {
    stopped.signal.throwIfAborted()
    init.dispatcher ??= direct
    return next()
  })
}
