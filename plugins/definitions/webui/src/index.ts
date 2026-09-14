import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/plugin-server'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export interface ClientEntry {
  id: string
  directory: string
  /** 仅包含可公开的客户端配置，禁止放入凭据。 */
  config?: Readonly<Record<string, unknown>>
}
export interface EntryManifest {
  id: string
  url: string
  config: Readonly<Record<string, unknown>>
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

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'webui')
    const directory = config.directory
      ? resolve(config.directory)
      : fileURLToPath(new URL('../public/', import.meta.url))
    ctx.server.static(ctx, '/', directory)
    ctx.server.use(ctx, async (http, next) => {
      if (!['GET', 'HEAD'].includes(http.method)) return next()
      if (http.path === '/webui/entries.json') {
        http.set('Cache-Control', 'no-store')
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
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    const mount = `/webui/extensions/${entry.id}/${randomUUID()}`
    const disposeStatic = this.ctx.server.static(owner, mount, entry.directory)
    const dispose = owner.effect(() => {
      const value = { id: entry.id, url: `${mount}/index.js`, config }
      this.entries.set(entry.id, value)
      return async () => {
        if (this.entries.get(entry.id) === value) this.entries.delete(entry.id)
        await disposeStatic()
        this.disposers.delete(dispose)
      }
    })
    this.disposers.add(dispose)
    return dispose
  }
}
export default WebUI
