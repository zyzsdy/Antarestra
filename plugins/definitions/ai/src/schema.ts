import { Ajv } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import AjvDraft04 from 'ajv-draft-04'
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' }
import type { Json, JsonObject } from '@antarestra/contracts'

export const schemaDialect = 'https://json-schema.org/draft/2020-12/schema'
type Draft = '04' | '06' | '07' | '2019-09' | '2020-12'
const uris: Record<Draft, string> = {
  '04': 'http://json-schema.org/draft-04/schema#',
  '06': 'http://json-schema.org/draft-06/schema#',
  '07': 'http://json-schema.org/draft-07/schema#',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  '2020-12': schemaDialect,
}
const options = { strict: false, validateFormats: false, addUsedSchema: false }
const legacy = new Ajv(options).addMetaSchema(draft06)
const validators = {
  '04': new AjvDraft04(options),
  '06': legacy,
  '07': legacy,
  '2019-09': new Ajv2019(options),
}
const maps = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependentSchemas',
])
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const singles = new Set([
  'additionalProperties',
  'additionalItems',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
])
const refSiblings = new Set([
  '$schema',
  '$id',
  'id',
  '$anchor',
  'definitions',
  '$defs',
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
])
const introduced2019 = [
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'minContains',
  'maxContains',
  '$recursiveRef',
  '$recursiveAnchor',
  '$anchor',
  'contentSchema',
]
const record = (): JsonObject => Object.create(null)
function object(value: Json | undefined): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function fail(message: string): never {
  throw new Error(`JSON Schema 无法转换：${message}`)
}
function declared(value: Json | undefined): Draft | undefined {
  if (value === undefined) return
  if (typeof value !== 'string') fail('$schema 必须是字符串')
  const draft = (Object.keys(uris) as Draft[]).find(
    (key) =>
      value.replace(/^https:/, 'http:').replace(/#$/, '') ===
      uris[key].replace(/^https:/, 'http:').replace(/#$/, ''),
  )
  return draft ?? fail(`不支持的方言 ${value}`)
}
function children(node: JsonObject, visit: (child: Json) => void) {
  for (const [key, value] of Object.entries(node)) {
    if ((maps.has(key) || key === 'dependencies') && object(value)) {
      for (const child of Object.values(value)) if (!Array.isArray(child)) visit(child)
    } else if ((arrays.has(key) || key === 'items') && Array.isArray(value)) {
      value.forEach(visit)
    } else if (singles.has(key)) visit(value)
  }
}
// 只检查 Schema 位置；default、enum、examples 和属性名均不是方言关键字。
function infer(node: JsonObject): Draft {
  let draft: Draft = '2020-12'
  const scan = (value: Json) => {
    if (!object(value)) return
    if (
      typeof value.exclusiveMinimum === 'boolean' ||
      typeof value.exclusiveMaximum === 'boolean' ||
      typeof value.id === 'string'
    )
      draft = '04'
    else if (draft !== '04' && (Array.isArray(value.items) || value.dependencies !== undefined))
      draft = '07'
    else if (
      draft === '2020-12' &&
      (value.$recursiveRef !== undefined || value.$recursiveAnchor !== undefined)
    )
      draft = '2019-09'
    children(value, scan)
  }
  scan(node)
  return draft
}
const pointer = (path: string, key: string) =>
  `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`

/** 在副本上迁移工具、Skill 与校验器的输入，调用方保留原始声明。 */
export function normalizeSchema(input: JsonObject): JsonObject {
  const source = structuredClone(input)
  const draft = declared(source.$schema) ?? infer(source)
  let hasContains = false
  let hasUnevaluatedItems = false
  const prepare = (value: Json) => {
    if (!object(value)) return
    const childDraft = declared(value.$schema)
    if (childDraft && childDraft !== draft) fail('同一文档内混合方言暂不支持，请拆分 Schema')
    if (childDraft) value.$schema = uris[draft]
    hasContains ||= value.contains !== undefined
    hasUnevaluatedItems ||= value.unevaluatedItems !== undefined && value.unevaluatedItems !== true
    if (
      draft !== '2020-12' &&
      (value.prefixItems !== undefined ||
        value.$dynamicRef !== undefined ||
        value.$dynamicAnchor !== undefined)
    )
      fail('旧方言中包含新版关键字，请明确使用 2020-12')
    if (
      ['04', '06', '07'].includes(draft) &&
      introduced2019.some((key) => value[key] !== undefined)
    )
      fail('旧方言中包含 2019-09 关键字，请明确声明正确的方言')
    if (
      draft === '04' &&
      ['const', 'contains', 'propertyNames'].some((key) => value[key] !== undefined)
    )
      fail('draft-04 中包含新版断言，请明确声明正确的方言')
    if (
      ['04', '06'].includes(draft) &&
      ['if', 'then', 'else'].some((key) => value[key] !== undefined)
    )
      fail('draft-04/06 中包含条件断言，请明确声明正确的方言')
    children(value, prepare)
  }
  prepare(source)
  source.$schema = uris[draft]
  if (draft !== '2020-12') {
    const validator = validators[draft]
    if (!validator.validateSchema(source)) fail(validator.errorsText())
  }
  // 2019-09 的 contains 不标记已求值项；直接更名会改变 unevaluatedItems 的语义。
  if (draft === '2019-09' && hasContains && hasUnevaluatedItems)
    fail('2019-09 的 contains 与 unevaluatedItems 组合需显式迁移')

  const locations = new Map<string, string>()
  const refs: { node: JsonObject; key: string; base: string }[] = []
  const recursiveResources = new Map<string, boolean>()
  const recursiveAnchor = 'antarestra_recursive'
  type Scope = { base: string; oldPath: string; newPath: string }
  const visit = (
    value: Json,
    oldPath: string,
    newPath: string,
    parentBase: string,
    scopes: Scope[],
  ): Json => {
    let base = parentBase
    let resourceRoot = oldPath === ''
    for (const scope of scopes)
      locations.set(
        `${scope.base}#${oldPath.slice(scope.oldPath.length)}`,
        newPath.slice(scope.newPath.length),
      )
    if (!object(value)) return value
    const result = record()
    const id = draft === '04' ? value.id : value.$id
    if (typeof id === 'string') {
      const resolved = new URL(id, base)
      if (resolved.hash) {
        if (draft === '2019-09' || draft === '2020-12') fail('$id 不能包含非空片段')
        result.$anchor = decodeURIComponent(resolved.hash.slice(1))
        resolved.hash = ''
      }
      const nextBase = resolved.href
      const idWithoutHash = id.split('#')[0]!
      if (idWithoutHash) {
        result.$id = idWithoutHash
        base = nextBase
        resourceRoot = true
        scopes = [...scopes, { base, oldPath, newPath }]
        locations.set(`${base}#`, '')
      }
    }
    if (resourceRoot) recursiveResources.set(base, value.$recursiveAnchor === true)
    const oldRef = ['04', '06', '07'].includes(draft) && typeof value.$ref === 'string'
    // 旧 $ref 的断言兄弟不参与校验；保留在未引用的定义中，使指向它们的指针仍可迁移。
    let ignored: JsonObject | undefined
    let ignoredKey = '_legacyRefSiblings'
    while (
      (object(value.$defs) && Object.hasOwn(value.$defs, ignoredKey)) ||
      (object(value.definitions) && Object.hasOwn(value.definitions, ignoredKey))
    )
      ignoredKey += '_'
    for (const [key, child] of Object.entries(value)) {
      if (key === '$schema' || key === '$id' || (key === 'id' && draft === '04')) continue
      let target = result
      let targetPath = newPath
      if (oldRef && key !== '$ref' && !refSiblings.has(key)) {
        ignored ??= record()
        target = ignored
        targetPath = pointer(pointer(newPath, '$defs'), ignoredKey)
      }
      if (key === '$recursiveAnchor' && draft === '2019-09') {
        if (child === true) {
          if (value.$anchor !== undefined) fail('递归锚点与静态锚点同时存在，需显式迁移')
          target.$dynamicAnchor = recursiveAnchor
        }
      } else if (key === '$recursiveRef' && draft === '2019-09') {
        if (child !== '#') fail('仅支持指向 # 的旧版递归引用')
        if (recursiveResources.get(base)) target.$dynamicRef = `#${recursiveAnchor}`
        else target.$ref = '#'
      } else if (key === 'dependencies' && object(child)) {
        for (const [name, dependency] of Object.entries(child)) {
          const keyword = Array.isArray(dependency) ? 'dependentRequired' : 'dependentSchemas'
          const group = object(target[keyword]) ? target[keyword] : record()
          if (Object.hasOwn(group, name)) fail(`依赖声明冲突：${name}`)
          group[name] = Array.isArray(dependency)
            ? dependency
            : visit(
                dependency,
                pointer(pointer(oldPath, key), name),
                pointer(pointer(targetPath, keyword), name),
                base,
                scopes,
              )
          target[keyword] = group
        }
      } else if (key === 'dependentRequired' && object(child)) {
        const group = object(target[key]) ? target[key] : record()
        for (const [name, dependency] of Object.entries(child)) {
          if (Object.hasOwn(group, name)) fail(`依赖声明冲突：${name}`)
          group[name] = dependency
        }
        target[key] = group
      } else if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && draft === '04') {
        if (child === true) target[key] = value[key === 'exclusiveMinimum' ? 'minimum' : 'maximum']!
      } else if (
        draft === '04' &&
        ((key === 'minimum' && value.exclusiveMinimum === true) ||
          (key === 'maximum' && value.exclusiveMaximum === true))
      ) {
        continue
      } else if (key === 'additionalItems' && draft !== '2020-12') {
        if (Array.isArray(value.items))
          target.items = visit(
            child,
            pointer(oldPath, key),
            pointer(targetPath, 'items'),
            base,
            scopes,
          )
      } else if (
        (key === 'items' && Array.isArray(child)) ||
        (arrays.has(key) && Array.isArray(child))
      ) {
        const keyword = key === 'items' && draft !== '2020-12' ? 'prefixItems' : key
        target[keyword] = child.map((item, i) =>
          visit(
            item,
            pointer(pointer(oldPath, key), String(i)),
            pointer(pointer(targetPath, keyword), String(i)),
            base,
            scopes,
          ),
        )
      } else if (maps.has(key) && object(child)) {
        // definitions 仍是 2020-12 支持的兼容关键字；升级为 $defs 并重写指向定义的引用。
        const keyword = key === 'definitions' ? '$defs' : key
        const group = object(target[keyword]) ? target[keyword] : record()
        for (const [name, item] of Object.entries(child)) {
          if (Object.hasOwn(group, name)) fail(`定义声明冲突：${name}`)
          group[name] = visit(
            item,
            pointer(pointer(oldPath, key), name),
            pointer(pointer(targetPath, keyword), name),
            base,
            scopes,
          )
        }
        target[keyword] = group
      } else if (singles.has(key)) {
        target[key] = visit(child, pointer(oldPath, key), pointer(targetPath, key), base, scopes)
      } else {
        target[key] = child
        if ((key === '$ref' || key === '$dynamicRef') && typeof child === 'string')
          refs.push({ node: target, key, base })
      }
    }
    if (ignored) {
      const defs = object(result.$defs) ? result.$defs : record()
      defs[ignoredKey] = ignored
      result.$defs = defs
    }
    if (value.$schema !== undefined) result.$schema = schemaDialect
    return result
  }
  const base = 'https://antarestra.invalid/schema'
  const result = visit(source, '', '', base, [{ base, oldPath: '', newPath: '' }]) as JsonObject
  for (const { node, key, base } of refs) {
    const ref = node[key] as string
    const resolved = new URL(ref, base)
    const fragment = decodeURIComponent(resolved.hash.slice(1))
    resolved.hash = ''
    const moved = locations.get(`${resolved.href}#${fragment}`)
    if (moved !== undefined && moved !== fragment)
      node[key] = `${ref.split('#')[0]}#${moved
        .split('/')
        .map((part) => encodeURIComponent(part).replace(/%24/g, '$'))
        .join('/')}`
  }
  return result
}
