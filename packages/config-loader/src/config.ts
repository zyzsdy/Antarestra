import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'

export interface PluginEntry {
  pluginId: string
  instanceId: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface ConfigLocation {
  argv: readonly string[]
  cwd: string
  defaultPath: string
}

export function resolveConfigPath(options: ConfigLocation): string {
  const args = options.argv.filter((arg) => arg === '--conf' || arg.startsWith('--conf='))
  if (args.length > 1) throw new Error('只能指定一次 --conf=路径')
  const argument = args[0]
  if (argument === '--conf') throw new Error('请使用 --conf=路径 指定配置文件')
  const selected = argument?.slice('--conf='.length)
  if (selected !== undefined) {
    if (!selected.trim()) throw new Error('配置文件路径不能为空')
    return resolve(options.cwd, selected)
  }
  return options.defaultPath
}

export function createInstanceId(pluginId: string): string {
  return `${pluginId}:${randomBytes(4).toString('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Environment = Readonly<Record<string, string | undefined>>

function resolveEnvironment(value: unknown, env: Environment): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('$')) return value
    const name = value.slice(1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('环境变量引用格式无效')
    const resolved = Object.hasOwn(env, name) ? env[name] : undefined
    if (resolved === undefined) throw new Error(`环境变量未配置：${name}`)
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => resolveEnvironment(item, env))
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvironment(item, env)]),
    )
  return value
}

export function parseConfig(
  source: string,
  env: Environment = process.env,
  raw = false,
): PluginEntry[] {
  // 禁止别名展开，避免共享可变配置和递归配置；不回显 YAML 原文中的凭据。
  let document: unknown
  try {
    const parsed = parseDocument(source, { uniqueKeys: true })
    if (parsed.errors.length) throw new Error()
    document = parsed.toJS({ maxAliasCount: 0 })
  } catch {
    throw new Error('主配置文件不是有效的 YAML，或包含重复键、别名')
  }
  if (!isRecord(document) || !isRecord(document.plugins)) {
    throw new Error('主配置必须包含 plugins 映射')
  }
  if (Object.keys(document).some((key) => !['plugins', 'loader', 'pluginPanel'].includes(key))) {
    throw new Error('主配置只支持 plugins、loader、pluginPanel 字段')
  }
  const entries: PluginEntry[] = []
  const identities = new Set<string>()
  const counts = new Map<string, number>()
  for (const [key, value] of Object.entries(document.plugins)) {
    const enabled = !key.startsWith('~')
    const instanceId = enabled ? key : key.slice(1)
    const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?::([a-f0-9]{8,32}))?$/.exec(
      instanceId,
    )
    const pluginId = match?.[1]
    if (!pluginId) throw new Error(`插件标识格式无效：${key}`)
    if (identities.has(instanceId)) throw new Error(`插件实例重复：${instanceId}`)
    if (value !== null && !isRecord(value)) {
      throw new Error(`插件配置必须是映射：${instanceId}`)
    }
    identities.add(instanceId)
    counts.set(pluginId, (counts.get(pluginId) ?? 0) + 1)
    entries.push({
      pluginId,
      instanceId,
      enabled,
      config:
        enabled && !raw
          ? (resolveEnvironment(value ?? {}, env) as Record<string, unknown>)
          : (value ?? {}),
    })
  }
  for (const entry of entries) {
    if (!raw && counts.get(entry.pluginId)! > 1 && entry.instanceId === entry.pluginId) {
      throw new Error(`多实例配置必须使用 插件名:随机哈希：${entry.pluginId}`)
    }
  }
  return entries
}

export async function readConfig(
  filename: string,
  env: Environment = process.env,
): Promise<PluginEntry[]> {
  let source: string
  try {
    source = await readFile(filename, 'utf8')
  } catch {
    throw new Error(`无法读取主配置文件：${filename}`)
  }
  try {
    let defaults: Environment = {}
    try {
      defaults = parseEnv(await readFile(resolve(dirname(filename), '.env'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取或解析同级 .env 文件')
    }
    const merged = { ...defaults }
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined)
        Object.defineProperty(merged, name, { value, enumerable: true, configurable: true })
    }
    return parseConfig(source, merged)
  } catch (error) {
    throw new Error(`主配置文件 ${filename}：${(error as Error).message}`)
  }
}
