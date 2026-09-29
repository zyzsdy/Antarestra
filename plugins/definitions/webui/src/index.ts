import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/plugin-server'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { EntryManifest } from './client.js'
export type { EntryManifest } from './client.js'

export interface ClientEntry {
  id: string
  directory: string
  /** 仅包含可公开的客户端配置，禁止放入凭据。 */
  config?: Readonly<Record<string, unknown>>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    webui: WebUI
  }
}

export interface Config {
  directory?: string
}

export class WebUI extends Service<Config> {
  static inject = ['server']
  private readonly entries = new Map<string, EntryManifest>()
  private readonly disposers = new Set<() => Promise<void>>()
  private readonly listeners = new Set<() => void>()
  private readonly assets = new Map<string, { directory: string; refresh: () => Promise<void> }>()
  private hmrPath: string | undefined
  private readonly connectOrigins = new Map<object, string>()

  /** 可信实现插件登记浏览器直传目标，只允许精确 HTTP(S) origin，随所属上下文回收。 */
  addConnectOrigin(owner: Context, value: string): void {
    this.ctx.fiber.assertActive()
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin === 'null'
    )
      throw new Error('浏览器连接源必须为 HTTP(S) origin')
    const token = {}
    owner.effect(() => {
      this.connectOrigins.set(token, url.origin)
      return () => {
        this.connectOrigins.delete(token)
      }
    })
  }

  getEntries(): EntryManifest[] {
    return [...this.entries.values()]
  }

  getDirectories(): { id: string; directory: string }[] {
    return [...this.assets].map(([id, asset]) => ({ id, directory: asset.directory }))
  }

  refreshEntry(id: string): Promise<void> {
    return this.assets.get(id)?.refresh() ?? Promise.resolve()
  }

  subscribe(owner: Context, listener: () => void): () => Promise<void> {
    return owner.effect(() => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    })
  }

  enableHmr(owner: Context, path: string): void {
    if (this.hmrPath) throw new Error('WebUI HMR 已启用')
    owner.effect(() => {
      this.hmrPath = path
      return () => {
        this.hmrPath = undefined
      }
    })
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'webui')
    config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), config)
    const directory = config.directory
      ? resolve(config.directory)
      : fileURLToPath(new URL('../public/', import.meta.url))
    ctx.server.static(ctx, '/', directory)
    ctx.server.use(ctx, async (http, next) => {
      if (!['GET', 'HEAD'].includes(http.method)) return next()
      if (http.path === '/webui/entries.json') {
        http.set('Cache-Control', 'no-store')
        if (this.hmrPath) http.set('X-WebUI-HMR', this.hmrPath)
        http.body = [...this.entries.values()]
        return
      }
      await next()
      if (
        http.status !== 404 ||
        http.path.startsWith('/api/') ||
        http.path === '/api' ||
        http.path.startsWith('/webui/') ||
        !http.accepts('html') ||
        /[.%\\]/.test(http.path)
      )
        return
      http.type = 'html'
      http.body = await readFile(resolve(directory, 'index.html'), 'utf8')
      http.status = 200
    })
    ctx.server.use(ctx, async (http, next) => {
      http.set('X-Content-Type-Options', 'nosniff')
      http.set(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ${[...new Set(this.connectOrigins.values())].join(' ')}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      )
      await next()
    })
    ctx.effect(() => async () => {
      await Promise.all([...this.disposers].map((dispose) => dispose()))
      this.entries.clear()
    })
  }

  addEntry(owner: Context, entry: ClientEntry): () => Promise<void> {
    this.ctx.fiber.assertActive()
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) throw new Error('WebUI 扩展标识无效')
    if (this.entries.has(entry.id)) throw new Error(`WebUI 扩展重复：${entry.id}`)
    const config = JSON.parse(JSON.stringify(entry.config ?? {})) as Record<string, unknown>
    const mountPath = () => `/webui/extensions/${entry.id}/${randomUUID()}`
    let mount = mountPath()
    let disposeStatic = this.ctx.server.static(owner, mount, entry.directory)
    const dispose = owner.effect(() => {
      const value = { id: entry.id, url: `${mount}/index.js`, config }
      this.entries.set(entry.id, value)
      this.assets.set(entry.id, {
        directory: resolve(entry.directory),
        refresh: async () => {
          if (this.entries.get(entry.id) !== value) return
          const previous = disposeStatic
          mount = mountPath()
          disposeStatic = this.ctx.server.static(owner, mount, entry.directory)
          value.url = `${mount}/index.js`
          this.changed()
          await previous()
        },
      })
      this.changed()
      return async () => {
        if (this.entries.get(entry.id) === value) {
          this.entries.delete(entry.id)
          this.assets.delete(entry.id)
          this.changed()
        }
        await disposeStatic()
        this.disposers.delete(dispose)
      }
    })
    this.disposers.add(dispose)
    return dispose
  }
}
export default WebUI
