import type { Plugin } from '@antarestra/plugin-sdk'
import type { PluginResolver } from './index.js'

export function pluginCandidates(name: string): readonly string[] {
  // 带 scope 的完整包名直接匹配，避免拼出无效的嵌套 scope。
  if (name.startsWith('@')) return [name]
  return [`@antarestra/${name}`, `@antarestra/plugin-${name}`, `antarestra-plugin-${name}`, name]
}

export function createPluginResolver(
  resolveModule: (specifier: string) => string,
  importModule: (url: string) => Promise<unknown> = (url) => import(url),
): PluginResolver {
  const resolveUrl = (pluginId: string): string => {
    for (const candidate of pluginCandidates(pluginId)) {
      let url: string
      try {
        url = resolveModule(candidate)
      } catch (error) {
        // 仅包不存在时尝试下一级，错误的 exports 等配置不能被静默跳过。
        if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
          continue
        }
        throw error
      }
      return url
    }
    throw new Error(`未找到插件：${pluginId}，已尝试 ${pluginCandidates(pluginId).join('、')}`)
  }
  const resolver: PluginResolver = async (pluginId) => {
    // 包已命中后，导入异常（包括内部依赖缺失）必须直接失败。
    const namespace = await importModule(resolveUrl(pluginId))
    if (typeof namespace !== 'object' || namespace === null) {
      throw new Error(`插件模块无效：${pluginId}`)
    }
    const exports = namespace as Record<string, unknown>
    const plugin = exports.default ?? exports
    if (
      typeof plugin !== 'function' &&
      !(
        typeof plugin === 'object' &&
        plugin !== null &&
        'apply' in plugin &&
        typeof plugin.apply === 'function'
      )
    ) {
      throw new Error(`插件必须导出默认函数、类或 apply 函数：${pluginId}`)
    }
    return plugin as Plugin<unknown>
  }
  resolver.resolveUrl = resolveUrl
  return resolver
}
