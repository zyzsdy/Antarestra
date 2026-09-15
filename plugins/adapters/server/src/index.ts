import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import Koa from 'koa'
import Router from '@koa/router'
import type { RouterMiddleware } from '@koa/router'
import compose from 'koa-compose'
import { readFile } from 'node:fs/promises'
import { createServer, METHODS } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createServer as createSecureServer } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { resolve } from 'node:path'
import { resolveConfig } from './config.js'
import type { Config } from './config.js'
import { respondError } from './errors.js'
import { serveStatic } from './static.js'
import type { StaticEntry } from './static.js'
import { sendStream } from './stream.js'

export type { Config } from './config.js'
export type HttpContext = Koa.ParameterizedContext<Record<string, unknown>>
export type Middleware = Koa.Middleware<Record<string, unknown>>
export type ApiHandler = RouterMiddleware<Record<string, unknown>>
export type Dispose = () => Promise<void>

interface RouteEntry {
  method: string
  path: string
  handlers: ApiHandler[]
}

declare module '@antarestra/plugin-sdk' {
  interface Context {
    server: HttpServer
  }
}

function normalizePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    /[?#\\\0]/.test(path) ||
    path.includes('//')
  ) {
    throw new Error('注册路径必须以 / 开头，且不包含查询、片段或反斜杠')
  }
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

export class HttpServer extends Service<Config> {
  private readonly config: Readonly<Required<Config>>
  private readonly middleware = new Set<Middleware>()
  private readonly routes = new Map<string, RouteEntry>()
  private readonly directories = new Map<string, StaticEntry>()
  private dispatch: Middleware = async () => {}
  private listener: ReturnType<typeof createServer> | undefined
  private active = true
  private readonly upgrades = new Map<
    string,
    (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  >()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'server')
    this.config = resolveConfig(config)
    this.rebuild()
    ctx.effect(() => () => {
      this.active = false
      this.middleware.clear()
      this.routes.clear()
      this.directories.clear()
      this.upgrades.clear()
      this.dispatch = async () => {}
    })
  }

  get publicUrl(): string {
    return this.config.publicUrl
  }

  get address(): Readonly<AddressInfo> | undefined {
    const address = this.listener?.address()
    return address && typeof address !== 'string' ? Object.freeze({ ...address }) : undefined
  }

  async [Service.init](): Promise<void> {
    const app = new Koa()
    const debug = this.config.debug
    const logger = this.ctx.logger('server')
    const reported = new WeakMap<Koa.Context, Set<unknown>>()
    const handleError = (http: Koa.Context, error: unknown) => {
      let errors = reported.get(http)
      if (!errors) reported.set(http, (errors = new Set()))
      if (!errors.has(error)) {
        errors.add(error)
        logger.error(
          '[http-error] %s',
          error instanceof Error ? (error.stack ?? error.message) : '未知异常',
        )
      }
      respondError(http, error, debug)
    }
    app.context.onerror = function (this: Koa.Context, error: unknown) {
      if (error != null) handleError(this, error)
    }
    app.use(async (ctx, next) => {
      const { res } = ctx
      const path = ctx.path.replace(/[\r\n\x1b]/g, '')
      const cleanup = () => {
        res.off('finish', finished)
        res.off('close', closed)
      }
      const finished = () => {
        cleanup()
        logger.info('[http-req] %s %s %d', ctx.method, path, res.statusCode)
      }
      const closed = () => {
        cleanup()
        logger.warn('[http-req] %s %s 连接中断', ctx.method, path)
      }
      res.once('finish', finished)
      res.once('close', closed)
      try {
        await this.dispatch(ctx, next)
        await sendStream(ctx)
      } catch (error) {
        handleError(ctx, error)
      }
    })
    const { host, port, https, cert, key, passphraseFile } = this.config
    const listener = https
      ? createSecureServer(
          {
            cert: await readFile(resolve(cert)),
            key: await readFile(resolve(key)),
            ...(passphraseFile
              ? {
                  passphrase: (await readFile(resolve(passphraseFile), 'utf8')).replace(
                    /[\r\n]+$/,
                    '',
                  ),
                }
              : {}),
          },
          app.callback(),
        )
      : createServer(app.callback())
    this.listener = listener
    listener.on('upgrade', (request, socket, head) => {
      const handler = this.upgrades.get((request.url ?? '').split('?')[0]!)
      if (handler) handler(request, socket, head)
      else socket.destroy()
    })
    const sockets = new Set<Socket>()
    listener.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    this.ctx.effect(
      () => () =>
        new Promise<void>((resolveClose, reject) => {
          const timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy()
          }, 5000)
          timer.unref()
          listener.close((error) => {
            clearTimeout(timer)
            if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING'))
              reject(error)
            else resolveClose()
          })
        }),
    )
    await new Promise<void>((resolveListen, reject) => {
      const failed = (error: Error) => reject(error)
      listener.once('error', failed)
      listener.listen(port, host, () => {
        listener.off('error', failed)
        resolveListen()
      })
    })
    const address = this.address!
    const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address
    logger.info('服务已监听 %s://%s:%d', https ? 'https' : 'http', hostname, address.port)
  }

  upgrade(
    owner: Context,
    path: string,
    handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): Dispose {
    path = normalizePath(path)
    if (this.upgrades.has(path)) throw new Error(`升级路径重复：${path}`)
    return this.register(
      owner,
      () => this.upgrades.set(path, handler),
      () => this.upgrades.delete(path),
    )
  }

  use(owner: Context, middleware: Middleware): Dispose {
    if (typeof middleware !== 'function') throw new Error('中间件必须是函数')
    // 每次注册拥有独立身份，同一个函数可以在不同位置重复使用。
    const entry: Middleware = (ctx, next) => middleware(ctx, next)
    return this.register(
      owner,
      () => this.middleware.add(entry),
      () => this.middleware.delete(entry),
    )
  }

  route(owner: Context, method: string, path: string, ...handlers: ApiHandler[]): Dispose {
    method = method.toUpperCase()
    path = normalizePath(path)
    if (path === '/api' || path.startsWith('/api/'))
      throw new Error('API 路径不应重复包含 /api 前缀')
    if (path === '/health') throw new Error('/api/health 是 server 保留接口')
    if (!METHODS.includes(method)) throw new Error('不支持的 HTTP 方法')
    if (!handlers.length || handlers.some((handler) => typeof handler !== 'function')) {
      throw new Error('API 至少需要一个处理函数')
    }
    const id = `${method} ${path}`
    if (this.routes.has(id)) throw new Error(`API 注册重复：${id}`)
    // 在产生注册副作用之前验证路由表达式。
    new Router().register(`/api${path === '/' ? '' : path}`, [method], handlers)
    const entry = { method, path, handlers }
    return this.register(
      owner,
      () => this.routes.set(id, entry),
      () => this.routes.delete(id),
    )
  }

  static(owner: Context, mountPath: string, directory: string): Dispose {
    mountPath = normalizePath(mountPath)
    if (mountPath === '/api' || mountPath.startsWith('/api/'))
      throw new Error('静态文件不能挂载到 /api')
    if (/[{}*:%]/.test(mountPath) || mountPath.split('/').some((part) => part.startsWith('.'))) {
      throw new Error('静态挂载路径必须是普通 URL 路径')
    }
    if (!directory.trim()) throw new Error('静态目录不能为空')
    if (this.directories.has(mountPath)) throw new Error(`静态挂载路径重复：${mountPath}`)
    const entry = { mountPath, directory: resolve(directory) }
    return this.register(
      owner,
      () => this.directories.set(mountPath, entry),
      () => this.directories.delete(mountPath),
    )
  }

  private register(owner: Context, add: () => unknown, remove: () => unknown): Dispose {
    if (!this.active) throw new Error('server 服务已卸载')
    return owner.effect(() => {
      add()
      this.rebuild()
      let active = true
      return () => {
        if (!active) return
        active = false
        remove()
        if (this.active) this.rebuild()
      }
    })
  }

  private rebuild(): void {
    const router = new Router<Record<string, unknown>>({ sensitive: true })
    router.get('/api/health', (ctx) => {
      ctx.body = { status: 'ok', time: new Date().toISOString() }
    })
    for (const entry of this.routes.values()) {
      router.register(`/api${entry.path === '/' ? '' : entry.path}`, [entry.method], entry.handlers)
    }
    // Router 在进入处理函数前填充 params 等路由上下文。
    const api = compose([router.routes(), router.allowedMethods()]) as Middleware
    const directories = [...this.directories.values()].sort(
      (a, b) => b.mountPath.length - a.mountPath.length,
    )
    this.dispatch = compose([
      ...this.middleware,
      async (ctx, next) => {
        if (ctx.path === '/api' || ctx.path.startsWith('/api/')) await api(ctx, next)
        else await serveStatic(ctx, directories)
      },
    ])
  }
}

export default HttpServer
