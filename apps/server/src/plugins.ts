import { createPluginResolver } from '@antarestra/config-loader'
import { createRequire } from 'node:module'

// 在 server 的依赖范围解析，Node 自动选用当前的条件导出。
export const resolvePlugin = createPluginResolver((specifier) => import.meta.resolve(specifier))
resolvePlugin.searchPaths = createRequire(import.meta.url).resolve.paths('antarestra-plugin') ?? []
