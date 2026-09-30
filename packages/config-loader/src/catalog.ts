import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigSchema } from '@antarestra/plugin-sdk/schema'
import type { PluginResolver } from './index.js'

export interface PluginMetadata {
  name: string
  title: string
  version: string
  description: string
  multipleInstances: boolean
  schema?: ConfigSchema
}
export async function metadata(resolver: PluginResolver, id: string): Promise<PluginMetadata> {
  if (!resolver.resolveUrl)
    return { name: id, title: '', version: '', description: '', multipleInstances: true }
  let directory = dirname(fileURLToPath(resolver.resolveUrl(id)))
  while (true) {
    let pkg: Record<string, unknown> | undefined
    try {
      pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('插件包描述无效')
    }
    if (pkg && typeof pkg.name === 'string') {
      if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('antarestra-plugin'))
        throw new Error('依赖包未声明 antarestra-plugin')
      const info = (pkg.antarestra ?? {}) as Record<string, unknown>
      let schema: ConfigSchema | undefined
      if (typeof info.configSchema === 'string') {
        const path = await realpath(resolve(directory, info.configSchema))
        const base = await realpath(directory)
        const within = relative(base, path)
        if (within.startsWith('..') || isAbsolute(within))
          throw new Error('Schema 必须位于插件包内')
        schema = JSON.parse(await readFile(path, 'utf8')) as ConfigSchema
      }
      return {
        name: pkg.name,
        title: typeof info.title === 'string' ? info.title : '',
        version: typeof pkg.version === 'string' ? pkg.version : '',
        description: typeof pkg.description === 'string' ? pkg.description : '',
        multipleInstances: info.multipleInstances === true,
        ...(schema ? { schema } : {}),
      }
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('无法读取插件包描述')
    directory = parent
  }
}
export async function discover(resolver: PluginResolver): Promise<PluginMetadata[]> {
  const names = new Set<string>()
  for (const directory of resolver.searchPaths ?? []) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        try {
          for (const child of await readdir(join(directory, entry.name)))
            names.add(`${entry.name}/${child}`)
        } catch {
          /* 非包目录。 */
        }
      } else names.add(entry.name)
    }
  }
  const result = new Map<string, PluginMetadata>()
  for (const name of names) {
    if (name === '@antarestra/config-loader') continue
    try {
      const item = await metadata(resolver, name)
      result.set(item.name, item)
    } catch {
      /* 不可解析或非插件包不作为候选。 */
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}
