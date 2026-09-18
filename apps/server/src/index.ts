import { Context } from '@antarestra/plugin-sdk'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
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

if (!isWorker && settings.supervision === 'internal') {
  let stopping = false
  let child: ReturnType<typeof spawn>
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const terminateTree = () => {
    if (!child.pid || child.exitCode !== null) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).once('error', () => child.kill('SIGKILL'))
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    if (child.connected) child.send({ type: 'shutdown' })
    else child.kill()
    killTimer = setTimeout(terminateTree, settings.disposalTimeoutMs)
    killTimer.unref()
  }
  const finish = (code: number) => {
    process.exitCode = code
    if (process.connected) process.disconnect()
  }
  const launch = () => {
    child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        env: { ...process.env, ANTARESTRA_WORKER: '1' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    )
    child.once('error', () => finish(1))
    child.once('exit', (code) => {
      clearTimeout(killTimer)
      if (stopping) {
        finish(0)
        return
      }
      if (code !== 75) {
        finish(code ?? 1)
        return
      }
      void loader
        .readDocument(filename)
        .then((file) => {
          if (file.settings.supervision === 'internal') launch()
          else finish(75)
        })
        .catch(() => finish(1))
    })
  }
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
      stop()
  })
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.once('disconnect', stop)
  launch()
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
  const stop = (code: number): Promise<void> =>
    (stopping ??= (async () => {
      const timer = setTimeout(() => process.exit(code || 1), settings.disposalTimeoutMs)
      try {
        await ctx.fiber.dispose()
      } catch {
        if (!code) code = 1
      }
      clearTimeout(timer)
      process.exit(code)
    })())
  process.once('SIGINT', () => void stop(0))
  process.once('SIGTERM', () => void stop(0))
  process.once('disconnect', () => void stop(0))
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown')
      void stop(0)
  })
  try {
    await ctx.plugin(loader, {
      filename,
      resolvePlugin,
      baseUrl: new URL('../../../', import.meta.url).href,
      restart: () => stop(75),
    })
  } catch {
    console.error('服务端启动失败，请检查主配置与基础服务')
    await stop(1)
  }
}
