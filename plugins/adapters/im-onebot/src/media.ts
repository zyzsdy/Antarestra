import {
  downloadHttpMedia,
  MediaSizeError,
  type IncomingMessage,
  type MediaSegment,
} from '@antarestra/im'
import type { Config } from './index.js'
import { id, normalizeMessage, normalizeSegments, record } from './message.js'

export async function downloadMedia(
  message: IncomingMessage,
  segment: MediaSegment,
  signal: AbortSignal,
  maxBytes: number,
  rpc: (action: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  provider: Config['provider'] = 'snowluma',
) {
  // 旧归档只保存了上报 URL；可从原始事件补回稳定文件标识。
  const raw = record(message.raw)
  const original = normalizeMessage(raw, id(raw.self_id) ?? '')
  const index = message.segments.findIndex(
    (item) =>
      item === segment || ('url' in item && item.type === segment.type && item.url === segment.url),
  )
  const originalSegment = original?.segments[index]
  let url =
    segment.reference ??
    (originalSegment && 'url' in originalSegment ? originalSegment.reference : undefined) ??
    segment.url
  // 旧引用曾将缺失 busid 写成 0；SnowLuma 应恢复原始字段，使用平台默认值。
  if (provider === 'snowluma' && originalSegment && 'url' in originalSegment)
    url = originalSegment.reference ?? url
  if (segment.size !== undefined && segment.size > maxBytes) throw new MediaSizeError()
  signal.throwIfAborted()
  if (provider === 'snowluma' && segment.type === 'video') {
    // SnowLuma 的 get_file 只支持图片/语音；视频从消息 URL 下载，失效后读取原消息刷新。
    if (/^https?:\/\//i.test(segment.url)) {
      try {
        const payload = await downloadHttpMedia(segment, signal, maxBytes)
        return { ...payload, mimeType: detectMimeType(payload.data, payload.mimeType) }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof MediaSizeError) throw error
      }
    }
    const result = record(await rpc('get_msg', { message_id: message.id }, signal))
    signal.throwIfAborted()
    if (
      id(result.message_id) !== message.id ||
      result.message_type !== message.chat.type ||
      id(message.chat.type === 'group' ? result.group_id : result.user_id) !== message.chat.id
    )
      throw new Error('视频消息不属于当前聊天')
    const refreshed = normalizeSegments(result.message)?.[index]
    if (
      !refreshed ||
      refreshed.type !== 'video' ||
      !refreshed.reference ||
      refreshed.reference !== url ||
      !/^https?:\/\//i.test(refreshed.url)
    )
      throw new Error('平台未提供可下载的视频 URL')
    if (refreshed.size !== undefined && refreshed.size > maxBytes) throw new MediaSizeError()
    const payload = await downloadHttpMedia({ ...segment, url: refreshed.url }, signal, maxBytes)
    return { ...payload, mimeType: detectMimeType(payload.data, payload.mimeType) }
  }
  // 图片直链不依赖平台文件缓存；失效时才使用保留的文件引用刷新。
  if (segment.type === 'image' && /^https?:\/\//i.test(segment.url)) {
    try {
      const payload = await downloadHttpMedia(segment, signal, maxBytes)
      return { ...payload, mimeType: detectMimeType(payload.data, payload.mimeType) }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof MediaSizeError || !url.startsWith('onebot://')) throw error
    }
  }
  let filename = segment.name
  if (url.startsWith('onebot://')) {
    const reference = new URL(url)
    const parts = reference.pathname.split('/').filter(Boolean)
    const file = decodeURIComponent(parts[0] ?? '')
    if (!file) throw new Error('平台媒体标识无效')
    const groupFile =
      reference.hostname === 'group-file' ||
      (segment.type === 'file' && message.chat.type === 'group')
    const privateFile = segment.type === 'file' && !groupFile
    const action = groupFile
      ? 'get_group_file_url'
      : privateFile
        ? 'get_private_file_url'
        : segment.type === 'audio'
          ? 'get_record'
          : segment.type === 'image'
            ? 'get_image'
            : 'get_file'
    const result = record(
      await rpc(
        action,
        groupFile
          ? {
              group_id: message.chat.id,
              file_id: file,
              ...(provider === 'napcat' || parts[1] !== undefined
                ? { busid: Number(parts[1] ?? 0) }
                : {}),
            }
          : privateFile
            ? {
                file_id: file,
                ...(provider === 'snowluma'
                  ? {
                      user_id: message.chat.id,
                      file_hash: reference.searchParams.get('file_hash') ?? '',
                    }
                  : {}),
              }
            : { file, ...(segment.type === 'audio' ? { out_format: 'mp3' } : {}) },
        signal,
      ),
    )
    signal.throwIfAborted()
    if (Number(result.file_size ?? result.size) > maxBytes) throw new MediaSizeError()
    filename ??= typeof result.file_name === 'string' ? result.file_name : undefined
    if (typeof result.base64 === 'string') {
      if (result.base64.length > Math.ceil(maxBytes / 3) * 4) throw new MediaSizeError()
      const data = Buffer.from(result.base64, 'base64')
      if (data.byteLength > maxBytes) throw new MediaSizeError()
      return {
        data,
        filename: filename ?? (segment.type === 'audio' ? '语音.mp3' : '媒体'),
        mimeType: detectMimeType(
          data,
          segment.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream',
        ),
      }
    }
    if (typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url))
      throw new Error('平台未提供可下载的 URL 或二进制内容')
    url = result.url
  }
  // 平台返回的本地路径属于机器人主机，不能拿来读取本服务文件系统。
  const payload = await downloadHttpMedia(
    { ...segment, url, ...(filename ? { name: filename } : {}) },
    signal,
    maxBytes,
  )
  return { ...payload, mimeType: detectMimeType(payload.data, payload.mimeType) }
}

function detectMimeType(data: Buffer, fallback: string) {
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return 'image/gif'
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp'
  if (
    data.subarray(4, 8).toString() === 'ftyp' &&
    ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(data.subarray(8, 12).toString())
  )
    return 'video/mp4'
  return fallback
}
