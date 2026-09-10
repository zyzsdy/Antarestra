import type { Context, Fiber, Plugin } from '@antarestra/plugin-sdk'
import { readConfig } from './config.js'
import type { PluginEntry } from './config.js'

export { createInstanceId, parseConfig, readConfig, resolveConfigPath } from './config.js'
export type { ConfigLocation, PluginEntry } from './config.js'
export { createPluginResolver, pluginCandidates } from './resolver.js'

export type PluginResolver = (pluginId: string) => Promise<Plugin<unknown>>

export interface Config {
  filename: string
  resolvePlugin: PluginResolver
}

export const name = 'config-loader'

// Cordis rc.10 的 FiberState 是环境 const enum，不能在 isolatedModules 下导入。
const ACTIVE = 2

export async function loadPlugins(
  ctx: Context,
  entries: readonly PluginEntry[],
  resolvePlugin: PluginResolver,
): Promise<ReadonlyMap<string, Fiber>> {
  const instances = new Map<string, Fiber>()
  try {
    for (const entry of entries) {
      if (!entry.enabled) continue
      if (instances.has(entry.instanceId)) throw new Error(`插件实例重复：${entry.instanceId}`)
      let fiber: Fiber
      try {
        const plugin = await resolvePlugin(entry.pluginId)
        fiber = ctx.plugin(plugin, structuredClone(entry.config))
        instances.set(entry.instanceId, fiber)
        await fiber
      } catch {
        throw new Error(`插件加载失败：${entry.instanceId}，请检查模块、配置及依赖`)
      }
    }
    // 后声明的服务可能触发前面插件的启动，需要再次等待并确认真正就绪。
    for (const [instanceId, fiber] of instances) {
      try {
        await fiber.await()
      } catch {
        throw new Error(`插件启动失败：${instanceId}`)
      }
      if (fiber.state !== ACTIVE) {
        throw new Error(`插件未就绪：${instanceId}，请检查启用的服务依赖`)
      }
    }
    return instances
  } catch (error) {
    const failures: unknown[] = [error]
    for (const fiber of [...instances.values()].reverse()) {
      try {
        await fiber.dispose()
      } catch {
        failures.push(new Error('插件资源清理失败'))
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, '插件加载及资源清理失败')
    throw error
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  await loadPlugins(ctx, await readConfig(config.filename), config.resolvePlugin)
}
