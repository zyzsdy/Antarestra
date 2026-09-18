import type { Context, Fiber, Plugin } from '@antarestra/plugin-sdk'
import { Entry, Loader } from '@antarestra/plugin-sdk/loader'
import { readConfig } from './config.js'
import type { PluginEntry } from './config.js'
import { ConfigManager } from './manager.js'
import { logPluginLifecycle } from './logging.js'
export { ConfigManager } from './manager.js'
export type { Operation, InstanceState } from './manager.js'
export { readDocument, ManagementError, loaderSchema } from './document.js'
export type { LoaderSettings, PanelLayout } from './document.js'
export type { PluginMetadata } from './catalog.js'

export { createInstanceId, parseConfig, readConfig, resolveConfigPath } from './config.js'
export type { ConfigLocation, PluginEntry } from './config.js'
export { createPluginResolver, pluginCandidates } from './resolver.js'

export interface PluginResolver {
  (pluginId: string): Promise<Plugin<unknown>>
  resolveUrl?: (pluginId: string) => string
  searchPaths?: readonly string[]
}

export interface Config {
  filename: string
  resolvePlugin: PluginResolver
  baseUrl?: string
  restart?: () => Promise<void>
}

export const name = 'config-loader'

// Cordis rc.10 的 FiberState 是环境 const enum，不能在 isolatedModules 下导入。
const ACTIVE = 2

export async function loadPlugins(
  ctx: Context,
  entries: readonly PluginEntry[],
  resolvePlugin: PluginResolver,
  baseUrl?: string,
): Promise<ReadonlyMap<string, Fiber>> {
  if (baseUrl) ctx = ctx.extend({ baseUrl })
  // 保留原有配置解析与启动语义，只向官方 loader 登记模块和实例供 HMR 使用。
  if (!resolvePlugin.resolveUrl) return loadEntries(ctx, entries, resolvePlugin)
  const loaderFiber = await ctx.plugin(Loader, baseUrl ? { baseUrl } : {})
  let result: ReadonlyMap<string, Fiber> = new Map()
  const scope = ctx.inject(['loader'], async (owner) => {
    result = await loadEntries(owner, entries, resolvePlugin)
  })
  try {
    await scope
    return result
  } catch (error) {
    await scope.dispose()
    await loaderFiber.dispose()
    throw error
  }
}

async function loadEntries(
  ctx: Context,
  entries: readonly PluginEntry[],
  resolvePlugin: PluginResolver,
): Promise<ReadonlyMap<string, Fiber>> {
  const instances = new Map<string, Fiber>()
  const track = logPluginLifecycle(ctx)
  if (resolvePlugin.resolveUrl) {
    const store = ctx.loader.store
    ctx.on('internal/plugin', (fiber) => {
      const entry = fiber.entry
      const id = entry?.options.id
      if (fiber.uid && id && fiber.parent.fiber === ctx.fiber && store[id] === entry) {
        instances.set(id, fiber)
        const configured = entries.find((entry) => entry.instanceId === id)
        if (configured) track(fiber, configured)
      }
    })
  }
  try {
    for (const entry of entries) {
      if (!entry.enabled) continue
      if (instances.has(entry.instanceId)) throw new Error(`插件实例重复：${entry.instanceId}`)
      let fiber: Fiber
      try {
        const plugin = await resolvePlugin(entry.pluginId)
        let owner = ctx
        if (resolvePlugin.resolveUrl) {
          const tracked = new Entry(ctx.loader)
          tracked.parent = ctx.loader.root
          tracked.options = {
            id: entry.instanceId,
            name: resolvePlugin.resolveUrl(entry.pluginId),
            config: structuredClone(entry.config),
          }
          // 不调用 Entry.update()，避免引入官方 loader 的 JS 表达式配置语义。
          owner = ctx.extend({ [Entry.key]: tracked, baseUrl: ctx.loader.ctx.baseUrl })
          tracked.ctx = owner
          ctx.loader.store[entry.instanceId] = tracked
          ctx.loader.root.data.push(tracked.options)
          fiber = owner.plugin(plugin, structuredClone(entry.config))
          tracked.fiber = fiber
        } else {
          fiber = owner.plugin(plugin, structuredClone(entry.config))
        }
        instances.set(entry.instanceId, fiber)
        track(fiber, entry)
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
  if (config.baseUrl) ctx = ctx.extend({ baseUrl: config.baseUrl })
  if (config.resolvePlugin.resolveUrl) {
    await ctx.plugin(Loader, config.baseUrl ? { baseUrl: config.baseUrl } : {})
    await ctx.inject(['loader'], async (owner) => {
      await owner.plugin(ConfigManager, config)
    })
  } else await ctx.plugin(ConfigManager, config)
}
