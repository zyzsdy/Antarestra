import { AiError, type Json, type JsonObject, type ToolImage } from '@antarestra/ai'
import type { MediaSegment } from '@antarestra/im'
import { normalizeSegments } from './message.js'

/** 保留转发节点结构，只替换图片；同次返回中的数组/CQ 重复表示共用资源。 */
export async function prepareForwardImages(
  value: Json,
  store: (segment: MediaSegment) => Promise<ToolImage>,
  signal: AbortSignal,
): Promise<Json> {
  const images = new Map<string, JsonObject>()
  async function image(value: Json): Promise<JsonObject> {
    signal.throwIfAborted()
    const segment = normalizeSegments(typeof value === 'string' ? value : [value])?.[0]
    if (segment?.type !== 'image') return { status: 'failed', error: '图片缺少下载地址或平台标识' }
    const existing = images.get(segment.url)
    if (existing) return existing
    let result: JsonObject
    try {
      const resource = await store(segment)
      signal.throwIfAborted()
      result = {
        resourceId: resource.resourceId,
        mimeType: resource.mimeType,
        filename: resource.filename,
        size: resource.size,
        width: resource.width,
        height: resource.height,
      }
    } catch (error) {
      signal.throwIfAborted()
      // 不将下载 URL、平台凭据或存储内部错误直接透传给模型。
      result = {
        status: 'failed',
        error: error instanceof AiError ? error.message : '图片下载或保存失败',
      }
    }
    images.set(segment.url, result)
    return result
  }
  async function visit(value: Json, messageText = false): Promise<Json> {
    signal.throwIfAborted()
    if (typeof value === 'string' && messageText) {
      let result = ''
      let position = 0
      for (const match of value.matchAll(/\[CQ:image(?:,[^\]]*)?\]/g)) {
        const resource = await image(match[0])
        result += value.slice(position, match.index)
        result += resource.resourceId
          ? `[图片,${resource.resourceId}]`
          : `[图片处理失败：${resource.error}]`
        position = match.index + match[0].length
      }
      return result + value.slice(position)
    }
    if (Array.isArray(value)) {
      const result: Json[] = []
      for (const entry of value) result.push(await visit(entry, messageText))
      return result
    }
    if (value && typeof value === 'object') {
      if (value.type === 'image') return { type: 'image', data: await image(value) }
      const result: JsonObject = {}
      for (const [key, entry] of Object.entries(value))
        result[key] = await visit(
          entry,
          ['message', 'raw_message', 'content', 'text'].includes(key),
        )
      return result
    }
    return value
  }
  return visit(value, true)
}
