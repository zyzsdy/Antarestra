export interface Schema {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  allOf?: Record<string, unknown>[]
  ['x-sensitive']?: boolean
  ['x-order']?: number
}
// 仅校验约束不改变字段结构，仍可由 properties 生成表单；校验交给服务端。
function validationOnly(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, item]) => {
    if (['const', 'enum', 'required'].includes(key)) return true
    if (['if', 'then', 'else', 'not'].includes(key)) return validationOnly(item)
    if (key === 'properties')
      return !!item && typeof item === 'object' && Object.values(item).every(validationOnly)
    return false
  })
}
export function supportsForm(schema?: Schema): boolean {
  if (
    !schema ||
    ['$ref', 'oneOf', 'anyOf', 'if', 'patternProperties'].some((key) => key in schema) ||
    (schema.allOf !== undefined && !schema.allOf.every(validationOnly))
  )
    return false
  if (schema.type === 'object')
    return (
      (schema.properties !== undefined || !schema.type) &&
      Object.values(schema.properties ?? {}).every(supportsForm)
    )
  return ['string', 'integer', 'number', 'boolean', 'array'].includes(schema.type ?? '')
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
