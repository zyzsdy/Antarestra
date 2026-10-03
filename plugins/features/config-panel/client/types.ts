export interface Schema {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  $ref?: string
  $defs?: Record<string, Schema>
  additionalProperties?: boolean | Schema
  format?: string
  allOf?: Record<string, unknown>[]
  oneOf?: Record<string, unknown>[]
  anyOf?: Record<string, unknown>[]
  ['x-sensitive']?: boolean
  ['x-order']?: number
}
// 仅校验约束不改变字段结构，仍可由 properties 生成表单；校验交给服务端。
function validationOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, item]) => {
    if (['const', 'enum', 'required'].includes(key)) return true
    if (['if', 'then', 'else', 'not'].includes(key)) return validationOnly(item)
    if (['allOf', 'oneOf', 'anyOf'].includes(key))
      return Array.isArray(item) && item.every(validationOnly)
    if (key === 'properties')
      return !!item && typeof item === 'object' && Object.values(item).every(validationOnly)
    return false
  })
}
/** 只展开本地引用；循环、外部引用及会改变字段结构的条件仍使用 YAML。 */
export function resolveFormSchema(
  schema?: Schema,
  root: Schema | undefined = schema,
  ancestors = new Set<Schema>(),
): Schema | undefined {
  if (!schema || typeof schema !== 'object' || ancestors.has(schema)) return undefined
  const seen = new Set(ancestors).add(schema)
  if (schema.$ref !== undefined) {
    if (!schema.$ref.startsWith('#/')) return undefined
    let target: unknown = root
    try {
      for (const part of decodeURIComponent(schema.$ref.slice(2)).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined
        target = (target as Record<string, unknown>)[key]
      }
    } catch {
      return undefined
    }
    const resolved = resolveFormSchema(target as Schema, root, seen)
    if (!resolved) return undefined
    const { $ref, ...siblings } = schema
    // 引用旁只接受展示注解，避免覆盖被引用结构中的校验约束。
    if (
      Object.keys(siblings).some(
        (key) => !['title', 'description', 'default', 'x-order', 'x-sensitive'].includes(key),
      )
    )
      return undefined
    return { ...resolved, ...siblings }
  }
  if (
    ['if', 'patternProperties'].some((key) => key in schema) ||
    [schema.allOf, schema.oneOf, schema.anyOf].some(
      (branches) => branches !== undefined && !branches.every(validationOnly),
    )
  )
    return undefined
  if (schema.type === 'object') {
    if (schema.properties === undefined && !schema.additionalProperties) return undefined
    const properties: Record<string, Schema> = {}
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      const resolved = resolveFormSchema(field, root, seen)
      if (!resolved) return undefined
      Object.defineProperty(properties, key, { value: resolved, enumerable: true })
    }
    return { ...schema, ...(schema.properties ? { properties } : {}) }
  }
  return ['string', 'integer', 'number', 'boolean', 'array'].includes(schema.type ?? '')
    ? schema
    : undefined
}
export function supportsForm(schema?: Schema): boolean {
  return resolveFormSchema(schema) !== undefined
}
export interface Settings {
  initializationTimeoutMs: number
  disposalTimeoutMs: number
  supervision: 'internal' | 'external'
}
export interface Layout {
  groups: { id: string; name: string }[]
  instances: Record<string, { alias?: string; group?: string; order?: number }>
}
export interface Instance {
  title: string
  instanceId: string
  pluginId: string
  enabled: boolean
  status: string
  error: string
  pending: boolean
  removed: boolean
  alias: string
  group: string
  order: number
}
export interface Snapshot {
  version: string
  generation: string
  loader: Settings
  runningLoader: Settings
  layout: Layout
  instances: Instance[]
}
export interface Metadata {
  title: string
  name: string
  version: string
  description: string
  multipleInstances: boolean
  schema?: Schema
}
export interface Detail {
  version: string
  entry: { instanceId: string; pluginId: string; enabled: boolean; config: Record<string, unknown> }
  yaml: string
  info?: Metadata
  impacts: string[]
}
export interface Operation {
  id: string
  state: string
  saved: boolean
  message: string
  snapshot?: Snapshot
}
