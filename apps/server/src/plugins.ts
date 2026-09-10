import type { Plugin } from '@antarestra/plugin-sdk'

const aliases: Readonly<Record<string, string>> = {
  agent: '@antarestra/agent',
  'agent-demo': '@antarestra/agent-demo',
  'adapter-cli': '@antarestra/adapter-cli',
}

export async function resolvePlugin(pluginId: string): Promise<Plugin<unknown>> {
  const specifier = Object.hasOwn(aliases, pluginId) ? aliases[pluginId]! : pluginId
  // 从 server 的依赖解析，保留 Node 的 development 条件导出。
  const namespace: unknown = await import(specifier)
  if (typeof namespace !== 'object' || namespace === null) {
    throw new Error('插件模块无效')
  }
  const exports = namespace as Record<string, unknown>
  const plugin =
    specifier === '@antarestra/agent' ? exports.AgentRegistry : (exports.default ?? exports)
  if (
    typeof plugin !== 'function' &&
    !(
      typeof plugin === 'object' &&
      plugin !== null &&
      'apply' in plugin &&
      typeof plugin.apply === 'function'
    )
  ) {
    throw new Error('插件必须导出默认函数、类或 apply 函数')
  }
  // 动态模块边界只验证 Cordis 入口形状；配置语义由插件自身校验。
  return plugin as Plugin<unknown>
}
