import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap } from 'yaml'
import type { Document, Node, Pair } from 'yaml'

const deletionTag = '!delete'
type ConfigNode = Node | null

// yaml 的 clone() 声明返回基类，实际克隆保留节点类型。
function cloneNode<T extends Node>(node: T): T {
  return node.clone() as T
}

function pairFor(map: YAMLMap, key: string) {
  return map.items.find((pair) => String(pair.key) === key)
}

function setPair(map: YAMLMap, key: string, value: ConfigNode) {
  const pair = pairFor(map, key)
  if (pair) pair.value = value
  else map.set(key, value)
}

function removePair(map: YAMLMap, key: string) {
  map.items = map.items.filter((pair) => String(pair.key) !== key)
}

function nodeValue(node: ConfigNode | undefined): unknown {
  return node === null ? null : node?.toJSON()
}

function checkNodes(node: ConfigNode, local: boolean, mapValue = false): void {
  if (node?.tag === deletionTag) {
    if (!local || !mapValue) throw new Error('删除标记只能用于本地覆盖文件的映射值')
    return
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !['string', 'number'].includes(typeof pair.key.value))
        throw new Error('配置映射键必须是字符串或数字')
      checkNodes(pair.value as ConfigNode, local, true)
    }
  } else if (isSeq(node)) {
    for (const item of node.items) checkNodes(item as ConfigNode, false)
  }
}

function parseLayer(source: string, local: boolean): Document<Node> {
  try {
    const document = parseDocument(source, {
      uniqueKeys: true,
      customTags: [{ tag: deletionTag, resolve: () => null }],
    })
    if (document.errors.length || document.warnings.length) throw new Error()
    document.toJS({ maxAliasCount: 0 })
    if (local && document.contents === null) document.set('plugins', {})
    if (!isMap(document.contents)) throw new Error()
    checkNodes(document.contents, local)
    const allowed = new Set(['plugins', 'loader', 'pluginPanel'])
    if (document.contents.items.some((pair) => !allowed.has(String(pair.key)))) throw new Error()
    const plugins = document.get('plugins', true)
    if ((!local || plugins !== undefined) && !isMap(plugins)) throw new Error()
    if (isMap(plugins)) {
      const ids = new Set<string>()
      for (const pair of plugins.items) {
        if ((pair.value as ConfigNode)?.tag === deletionTag) continue
        const id = String(pair.key).replace(/^~/, '')
        if (ids.has(id)) throw new Error()
        ids.add(id)
      }
    }
    return document
  } catch {
    throw new Error(
      `${local ? '本地覆盖' : '主'}配置文件不是有效的 YAML 映射，或包含无效字段、重复键、别名、删除标记`,
    )
  }
}

/** 映射递归合并，数组、标量与 null 整体覆盖；保留 YAML 注释。 */
function mergeNode(base: ConfigNode, local: ConfigNode, path: string[] = []): ConfigNode {
  if (!isMap(local)) return local ? cloneNode(local) : null
  const result = isMap(base) ? cloneNode(base) : cloneNode(local)
  if (!isMap(base)) result.items = []
  for (const pair of local.items) {
    const key = String(pair.key)
    const value = pair.value as ConfigNode
    if (value?.tag === deletionTag) {
      removePair(result, key)
      continue
    }
    let previous = pairFor(result, key)?.value as ConfigNode | undefined
    if (path.length === 1 && path[0] === 'plugins') {
      const opposite = key.startsWith('~') ? key.slice(1) : `~${key}`
      previous ??= pairFor(result, opposite)?.value as ConfigNode | undefined
      removePair(result, opposite)
    }
    setPair(result, key, mergeNode(previous ?? null, value, [...path, key]))
  }
  return result
}

export function mergeDocuments(
  base: ReturnType<typeof parseLayer>,
  local: ReturnType<typeof parseLayer>,
) {
  const document = base.clone()
  document.contents = mergeNode(base.contents, local.contents) as typeof document.contents
  return document
}

/** 只更新发生变化的覆盖项，保留未编辑的显式覆盖及注释。 */
function overlayNode(
  base: ConfigNode | undefined,
  before: ConfigNode | undefined,
  after: ConfigNode | undefined,
  local: ConfigNode | undefined,
): ConfigNode | undefined {
  if (isDeepStrictEqual(nodeValue(before), nodeValue(after)) && local !== undefined)
    return local ? cloneNode(local) : null
  if (after === undefined) {
    if (base === undefined) return undefined
    const marker = new Scalar(null)
    marker.tag = deletionTag
    return marker
  }
  if (isMap(base) && isMap(after)) {
    const result = isMap(local) ? cloneNode(local) : cloneNode(after)
    result.items = []
    const keys = new Set(
      [...base.items, ...after.items, ...(isMap(local) ? local.items : [])].map((pair) =>
        String(pair.key),
      ),
    )
    for (const key of keys) {
      const value = overlayNode(
        pairFor(base, key)?.value as ConfigNode | undefined,
        isMap(before) ? (pairFor(before, key)?.value as ConfigNode | undefined) : undefined,
        pairFor(after, key)?.value as ConfigNode | undefined,
        isMap(local) ? (pairFor(local, key)?.value as ConfigNode | undefined) : undefined,
      )
      if (value !== undefined) {
        const pair = (isMap(local) ? pairFor(local, key) : undefined)?.clone() as Pair | undefined
        if (pair) {
          pair.value = value
          result.items.push(pair)
        } else setPair(result, key, value)
      }
    }
    return result.items.length ? result : undefined
  }
  if (isDeepStrictEqual(nodeValue(base), nodeValue(after))) return undefined
  return after ? cloneNode(after) : null
}

export function writeOverlay(
  base: ReturnType<typeof parseLayer>,
  before: ReturnType<typeof parseLayer>,
  after: ReturnType<typeof parseLayer>,
  local: ReturnType<typeof parseLayer>,
) {
  const document = local.clone()
  document.contents = (overlayNode(
    base.contents,
    before.contents,
    after.contents,
    local.contents,
  ) ?? new YAMLMap()) as typeof document.contents
  return document
}

export async function readLayers(filename: string) {
  let baseSource: string
  try {
    baseSource = await readFile(filename, 'utf8')
  } catch {
    throw new Error(`无法读取主配置文件：${filename}`)
  }
  let localSource: string | undefined
  try {
    localSource = await readFile(`${filename}.local`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('无法读取本地覆盖配置文件')
  }
  const baseDocument = parseLayer(baseSource, false)
  const localDocument = localSource === undefined ? undefined : parseLayer(localSource, true)
  const document = localDocument
    ? mergeDocuments(baseDocument, localDocument)
    : baseDocument.clone()
  return {
    baseSource,
    localSource,
    baseDocument,
    localDocument,
    document,
    writeFilename: localDocument ? `${filename}.local` : filename,
  }
}
