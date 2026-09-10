import { Context } from '@antarestra/plugin-sdk'
import { fileURLToPath } from 'node:url'
import * as loader from '@antarestra/config-loader'
import { resolvePlugin } from './plugins.js'

const ctx = new Context()

let stopping: Promise<void> | undefined

function stop(): Promise<void> {
  return (stopping ??= ctx.fiber.dispose())
}

function shutdown(): void {
  void stop().catch(() => {
    console.error('服务端资源清理失败')
    process.exitCode = 1
  })
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.once('beforeExit', shutdown)

try {
  const filename = loader.resolveConfigPath({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    defaultPath: fileURLToPath(new URL('../../../antarestra.yml', import.meta.url)),
  })
  await ctx.plugin(loader, { filename, resolvePlugin })
} catch (error) {
  console.error(error instanceof Error ? error.message : '服务端启动失败')
  process.exitCode = 1
  shutdown()
}
