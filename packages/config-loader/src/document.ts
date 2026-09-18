import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { parseDocument } from 'yaml'
import { validateConfig } from '@antarestra/plugin-sdk/schema'
import { parseConfig } from './config.js'

export interface LoaderSettings {
  initializationTimeoutMs: number
  disposalTimeoutMs: number
  supervision: 'internal' | 'external'
}
export interface PanelLayout {
  groups: { id: string; name: string }[]
  instances: Record<string, { alias?: string; group?: string; order?: number }>
}
export const loaderSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    initializationTimeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 90000,
      title: '初始化超时（毫秒）',
    },
    disposalTimeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      default: 30000,
      title: '清理超时（毫秒）',
    },
    supervision: {
      type: 'string',
      enum: ['internal', 'external'],
      default: 'internal',
      title: '进程监督模式',
    },
  },
}
const layoutSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', pattern: '^[a-zA-Z0-9-]{1,64}$' },
          name: { type: 'string', minLength: 1, maxLength: 80 },
        },
      },
    },
    instances: {
      type: 'object',
      default: {},
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alias: { type: 'string', maxLength: 120 },
          group: { type: 'string', maxLength: 64 },
          order: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
}
export class ManagementError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export function validateLayout(value: unknown): PanelLayout {
  const layout = validateConfig<PanelLayout>(layoutSchema, value)
  const ids = new Set(layout.groups.map((group) => group.id))
  if (ids.size !== layout.groups.length) throw new ManagementError(400, '分组标识重复')
  for (const meta of Object.values(layout.instances))
    if (meta.group && !ids.has(meta.group)) throw new ManagementError(400, '分组不存在')
  return layout
}
export async function environment(filename: string) {
  let defaults: Record<string, string | undefined> = {}
  try {
    defaults = parseEnv(await readFile(resolve(dirname(filename), '.env'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ManagementError(400, '无法读取同级环境配置')
  }
  return {
    ...defaults,
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  }
}
export async function readDocument(filename: string) {
  const source = await readFile(filename, 'utf8')
  const entries = parseConfig(source, {}, true)
  const document = parseDocument(source, { uniqueKeys: true })
  const value = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>
  const settings = validateConfig<LoaderSettings>(loaderSchema, value.loader ?? {})
  const layout = validateLayout(value.pluginPanel ?? {})
  return {
    source,
    document,
    entries,
    settings,
    layout,
    version: createHash('sha256').update(source).digest('hex'),
  }
}
export async function writeDocument(
  filename: string,
  version: string,
  mutate: (document: Awaited<ReturnType<typeof readDocument>>['document']) => void,
) {
  const current = await readDocument(filename)
  if (current.version !== version)
    throw new ManagementError(409, '配置文件已变化，请刷新后重新提交；当前草稿已保留')
  mutate(current.document)
  const source = current.document.toString()
  parseConfig(source, {}, true)
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(source, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if ((await readDocument(filename)).version !== version)
      throw new ManagementError(409, '配置文件已变化，请刷新后重新提交')
    await rename(temporary, filename)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return readDocument(filename)
}
