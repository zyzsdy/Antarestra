import { Ajv2020 } from 'ajv/dist/2020.js'
import type { Json, JsonObject } from '@antarestra/contracts'
import { normalizeSchema } from './schema.js'
export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AiError('invalid_request', message)
}
export function identifier(value: unknown): asserts value is string {
  check(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 200 &&
      !/[\x00-\x1f]/.test(value),
    '标识无效',
  )
}
export function json<T>(value: T): T {
  const encoded = JSON.stringify(value)
  check(encoded !== undefined, '内容必须可序列化')
  return JSON.parse(encoded) as T
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}
const ajv = new Ajv2020({
  strict: false,
  allErrors: false,
  validateFormats: false,
  addUsedSchema: true,
})
type CompiledSchema = ((value: unknown) => void) & { schema: JsonObject }
const compiledSchemas = new WeakMap<JsonObject, { source: string; validate: CompiledSchema }>()
export function compile(schema: JsonObject) {
  const source = JSON.stringify(schema)
  const cached = compiledSchemas.get(schema)
  if (cached?.source === source) return cached.validate
  const normalized = freeze(normalizeSchema(schema))
  try {
    const validate = ajv.compile(normalized)
    const compiled = Object.assign(
      (value: unknown) => check(validate(value), '参数不符合声明的 Schema'),
      {
        schema: normalized,
      },
    )
    compiledSchemas.set(schema, { source, validate: compiled })
    return compiled
  } finally {
    // Ajv 的内部缓存强引用 Schema；工具可热卸载，由弱引用缓存管理其寿命。
    ajv.removeSchema()
  }
}
export function template(source: string, variables: JsonObject): string {
  return source.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    check(Object.hasOwn(variables, key), `模板变量缺失：${key}`)
    const value = variables[key]
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // 请求已创建后才发现取消时，仍须接管它的拒绝，避免重试/卸载产生未处理异常。
    void promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {})
  })
}
export function payload(value: unknown): Json {
  return json(value) as Json
}
