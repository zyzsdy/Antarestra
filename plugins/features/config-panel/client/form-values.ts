import { parseDocument, visit } from 'yaml'
// 字典的展示顺序随 YAML 保存；避免 JavaScript 对纯数字对象键重新排序。
const order = Symbol('配置字典键顺序')
type OrderedRecord = Record<string, unknown> & { [order]?: string[] }
export function orderedEntries(value: Record<string, unknown>): [string, unknown][] {
  const keys = (value as OrderedRecord)[order] ?? Object.keys(value)
  return [
    ...keys.filter((key) => Object.hasOwn(value, key)),
    ...Object.keys(value).filter((key) => !keys.includes(key)),
  ].map((key) => [key, value[key]])
}
export function orderedRecord(entries: [string, unknown][]): Record<string, unknown> {
  const result = Object.fromEntries(entries)
  Object.defineProperty(result, order, { value: entries.map(([key]) => key), configurable: true })
  return result
}
export function fromYamlValue(value: unknown): unknown {
  if (value instanceof Map)
    return orderedRecord([...value].map(([key, item]) => [String(key), fromYamlValue(item)]))
  if (Array.isArray(value)) return value.map(fromYamlValue)
  return value
}
export function toYamlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toYamlValue)
  if (value && typeof value === 'object')
    return new Map(
      orderedEntries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toYamlValue(item),
      ]),
    )
  return value
}

export function parseFormYaml(text: string): unknown {
  const document = parseDocument(text)
  if (document.errors.length) return undefined
  return fromYamlValue(document.toJS({ maxAliasCount: 0, mapAsMap: true }))
}
export function updateFormYaml(
  text: string,
  path: string[],
  value: unknown,
  remove = false,
): string {
  const document = parseDocument(text)
  if (document.errors.length) return text
  if (remove) document.deleteIn(path)
  else document.setIn(path, toYamlValue(value))
  visit(document, {
    Collection(_key, node) {
      node.flow = node.items.length === 0
    },
  })
  return document.toString()
}
