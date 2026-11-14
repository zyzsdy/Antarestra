import { Context } from '@antarestra/plugin-sdk'
import { fileURLToPath } from 'node:url'
import { supervise } from './supervisor.js'
import * as loader from '@antarestra/config-loader'
import type {} from '@antarestra/plugin-server'
import { resolvePlugin } from './plugins.js'

const filename = loader.resolveConfigPath({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  defaultPath: fileURLToPath(new URL('../../../antarestra.yml', import.meta.url)),
})
const settings = (await loader.readDocument(filename)).settings
const isWorker = process.env.ANTARESTRA_WORKER === '1'

if (!isWorker) {
  supervise(filename, fileURLToPath(import.meta.url), process.argv.includes('--watch'))
} else {
  const ctx = new Context()
  ctx.inject(['server', 'configManager'], (owner) => {
    const generation = owner.configManager.generation
    owner.server.use(owner, async (http, next) => {
      if (http.path === '/api/health') http.set('X-Antarestra-Generation', generation)
      await next()
    })
  })
  let stopping: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let exitCode = 0
  const stop = (code: number): Promise<void> => {
    // 用户关闭取消已有的重启超时，持续等待清理；失败与面板重启仍有超时保护。
    if (code === 0) {
      clearTimeout(timer)
      exitCode = 0
    }
    return (stopping ??= (async () => {
      exitCode = code
      if (code !== 0) timer = setTimeout(() => process.exit(code), settings.disposalTimeoutMs)
      try {
        await ctx.fiber.dispose()
      } catch {
        exitCode = 1
      }
      clearTimeout(timer)
      process.exit(exitCode)
    })())
  }
  // Windows 控制台可能同时通知父子进程；只接受监督进程的 IPC 关闭请求。
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})
  process.once('disconnect', () => void stop(0))
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
      void stop(0)
  })
  try {
    await ctx.use(loader, {
      filename,
      resolvePlugin,
      baseUrl: new URL('../../../', import.meta.url).href,
      restart: () => stop(75),
    })
    process.send?.({ type: 'ready' })
  } catch {
    console.error('服务端启动失败，请检查主配置与基础服务')
    await stop(1)
  }
}
