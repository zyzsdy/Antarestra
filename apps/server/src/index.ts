import { Context } from 'cordis'
import { installDevelopmentProfile } from './profile.js'

const ctx = new Context()

async function stop(): Promise<void> {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await ctx.fiber.dispose()
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  await installDevelopmentProfile(ctx)
} finally {
  // 当前 profile 是一次性演示，没有 HTTP 监听；完成后回收全部资源。
  await stop()
}
