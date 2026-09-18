import type { Context, Fiber } from '@antarestra/plugin-sdk'
import type { PluginEntry } from './config.js'

export function logPluginLifecycle(ctx: Context) {
  const entries = new WeakMap<Fiber, PluginEntry>()
  const logger = ctx.logger('config-loader')
  // Cordis rc.10 的 FiberState 是环境 const enum，isolatedModules 下使用对应数值。
  const log = (fiber: Fiber) => {
    const entry = entries.get(fiber)
    if (!entry) return
    if (fiber.state === 2) logger.info('插件已加载：%s', entry.instanceId)
    if (fiber.state === 5) logger.info('正在卸载插件：%s', entry.instanceId)
  }
  // 在创建子插件前注册，父上下文卸载时仍能记录子插件的清理。
  ctx.on('internal/status', log)
  return (fiber: Fiber, entry: PluginEntry) => {
    fiber = fiber.ctx.fiber
    if (entries.has(fiber)) return
    entries.set(fiber, entry)
    // 同步插件可能在 plugin() 返回之前就已经就绪。
    log(fiber)
  }
}
