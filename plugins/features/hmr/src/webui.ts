import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/webui'
import '@antarestra/plugin-server'
import { watch } from 'chokidar'
import { WebSocketServer, WebSocket } from 'ws'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function within(parent: string, path: string): boolean {
  const suffix = relative(parent, path)
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

/** 与服务端 HMR 独立的前端桥接，随可选服务依赖自动回收。 */
export function applyWebHmr(ctx: Context, roots: string[], excluded: string[]): void {
  const path = '/webui/hmr'
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 })
  const watchers = new Map<string, ReturnType<typeof watch>>()
  const pending = new Set<Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let active = true
  const snapshot = () => JSON.stringify({ type: 'entries', entries: ctx.webui.getEntries() })
  const update = () => {
    if (!active) return
    const directories = new Map(
      ctx.webui
        .getDirectories()
        .filter(
          ({ directory }) =>
            roots.some((root) => within(root, directory)) &&
            !excluded.some((root) => within(root, directory)),
        )
        .map((entry) => [entry.id, entry.directory]),
    )
    for (const [key, watcher] of watchers) {
      const [id, directory] = JSON.parse(key) as [string, string]
      if (directories.get(id) === directory) continue
      clearTimeout(timers.get(key))
      timers.delete(key)
      const closing = watcher.close()
      pending.add(closing)
      void closing.finally(() => pending.delete(closing))
      watchers.delete(key)
    }
    for (const [id, directory] of directories) {
      const key = JSON.stringify([id, directory])
      if (watchers.has(key)) continue
      const watcher = watch(directory, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
        ignored: (filename) => excluded.some((root) => within(root, resolve(filename))),
      })
      watchers.set(key, watcher)
      watcher.on('error', (error) => ctx.logger('hmr').warn('前端监视失败：%s', error))
      watcher.on('all', () => {
        if (!active || watchers.get(key) !== watcher) return
        clearTimeout(timers.get(key))
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key)
            if (active && watchers.get(key) === watcher)
              void ctx.webui
                .refreshEntry(id)
                .catch((error) => ctx.logger('hmr').warn('前端更新失败：%s', error))
          }, 200),
        )
      })
    }
    const message = snapshot()
    for (const socket of sockets.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message)
    }
  }
  ctx.effect(() => async () => {
    active = false
    for (const timer of timers.values()) clearTimeout(timer)
    for (const socket of sockets.clients) socket.close(1000, 'HMR 已停用')
    await Promise.all([
      ...[...watchers.values()].map((watcher) => watcher.close()),
      ...pending,
      new Promise<void>((resolveClose) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets.clients) socket.terminate()
        }, 500)
        sockets.close(() => {
          clearTimeout(timeout)
          resolveClose()
        })
      }),
    ])
  })
  ctx.server.upgrade(ctx, path, (request, socket, head) => {
    // 开发通道只接受当前站点的浏览器连接。
    const protocol = 'encrypted' in request.socket ? 'https' : 'http'
    if (request.headers.origin !== `${protocol}://${request.headers.host}`) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on('error', () => client.terminate())
      client.send(snapshot())
    })
  })
  ctx.webui.enableHmr(ctx, path)
  ctx.webui.subscribe(ctx, update)
  update()
}
