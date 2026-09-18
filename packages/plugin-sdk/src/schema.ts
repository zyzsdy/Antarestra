import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchemaObject, ValidateFunction } from 'ajv'

export type ConfigSchema = AnySchemaObject
const validator = new Ajv2020({
  allErrors: true,
  useDefaults: true,
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
})
const compiled = new Map<string, ValidateFunction>()
const cache = new Map<string, ConfigSchema>()

/** 静态 Schema 不加载网络资源；错误只报告路径和规则，不包含配置值。 */
export function readConfigSchema(url: URL): ConfigSchema {
  const key = url.href
  let schema = cache.get(key)
  if (!schema) {
    schema = JSON.parse(readFileSync(url, 'utf8')) as ConfigSchema
    cache.set(key, schema)
  }
  return schema
}

export function validateConfig<T>(schema: ConfigSchema, input: unknown): T {
  const value: unknown = structuredClone(input)
  const key = JSON.stringify(schema)
  let validate = compiled.get(key)
  if (!validate) {
    validate = validator.compile(schema)
    compiled.set(key, validate)
    validator.removeSchema(schema)
    if (compiled.size > 128) compiled.delete(compiled.keys().next().value!)
  }
  if (!validate(value)) {
    throw new Error(
      '配置校验失败：' +
        (validate.errors ?? [])
          .map(
            (item) =>
              `${item.instancePath || '/'} ${item.keyword}${item.keyword === 'required' ? ' ' + String(item.params.missingProperty) : ''}`,
          )
          .join('；'),
    )
  }
  return value as T
}

export function schemaConfig<T>(url: URL, input: unknown): T {
  return validateConfig<T>(readConfigSchema(url), input)
}

/** 只转换环境变量引用，普通 YAML 值不进行隐式类型转换。 */
export function resolveConfigEnvironment(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  schema?: ConfigSchema,
  root: ConfigSchema | undefined = schema,
): unknown {
  const seen = new Set<ConfigSchema>()
  const expand = (current?: ConfigSchema): ConfigSchema | undefined => {
    if (!current || seen.has(current)) return undefined
    seen.add(current)
    let result = { ...current }
    const branches: ConfigSchema[] = [...(current.allOf ?? [])]
    if (typeof current.$ref === 'string' && current.$ref.startsWith('#/')) {
      let reference: unknown = root
      for (const part of current.$ref.slice(2).split('/')) {
        const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
        reference =
          reference && typeof reference === 'object'
            ? (reference as Record<string, unknown>)[key]
            : undefined
      }
      if (reference && typeof reference === 'object') branches.unshift(reference as ConfigSchema)
    }
    for (const branch of branches) {
      const expanded = expand(branch)
      if (expanded)
        result = {
          ...expanded,
          ...result,
          properties: { ...expanded.properties, ...result.properties },
        }
    }
    delete result.$ref
    delete result.allOf
    return result
  }
  schema = expand(schema)
  if (schema?.if) {
    const { if: condition, then: yes, else: no, ...base } = schema
    const probe = resolveConfigEnvironment(value, env, base, root)
    let matched = true
    try {
      validateConfig({ $defs: root?.$defs, definitions: root?.definitions, ...condition }, probe)
    } catch {
      matched = false
    }
    const branch = matched ? yes : no
    return resolveConfigEnvironment(value, env, branch ? { ...base, allOf: [branch] } : base, root)
  }
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema?.[keyword] as ConfigSchema[] | undefined
    if (!branches) continue
    const base: ConfigSchema = { ...schema }
    delete base[keyword]
    let failure: unknown
    for (const branch of branches) {
      try {
        const candidate = resolveConfigEnvironment(value, env, { ...base, allOf: [branch] }, root)
        return validateConfig(
          { $defs: root?.$defs, definitions: root?.definitions, ...schema },
          candidate,
        )
      } catch (error) {
        failure ??= error
      }
    }
    throw failure ?? new Error('配置条件分支无匹配项')
  }
  if (typeof value === 'string' && value.startsWith('$')) {
    const name = value.slice(1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('环境变量引用格式无效')
    const resolved = Object.hasOwn(env, name) ? env[name] : undefined
    if (resolved === undefined) throw new Error(`环境变量未配置：${name}`)
    if (schema?.type === 'boolean') {
      if (resolved !== 'true' && resolved !== 'false')
        throw new Error(`环境变量必须为 true 或 false：${name}`)
      return resolved === 'true'
    }
    if (schema?.type === 'number' || schema?.type === 'integer') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(resolved))
        throw new Error(`环境变量不是有效数字：${name}`)
      const number = Number(resolved)
      if (!Number.isFinite(number) || (schema.type === 'integer' && !Number.isSafeInteger(number)))
        throw new Error(`环境变量数字超出范围：${name}`)
      return number
    }
    return resolved
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      resolveConfigEnvironment(
        item,
        env,
        (schema?.prefixItems?.[index] ?? schema?.items) as ConfigSchema | undefined,
        root,
      ),
    )
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveConfigEnvironment(
          item,
          env,
          (schema?.properties?.[key] ??
            (typeof schema?.additionalProperties === 'object'
              ? schema.additionalProperties
              : undefined)) as ConfigSchema | undefined,
          root,
        ),
      ]),
    )
  return value
}
