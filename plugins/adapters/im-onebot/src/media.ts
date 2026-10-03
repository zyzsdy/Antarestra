import { downloadHttpMedia, type IncomingMessage, type MediaSegment } from '@antarestra/im'
import { record } from './message.js'

export async function downloadMedia(
  message: IncomingMessage,
  segment: MediaSegment,
  signal: AbortSignal,
  maxBytes: number,
  rpc: (action: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  let url = segment.url
  let filename = segment.name
  if (url.startsWith('onebot://')) {
    const reference = new URL(url)
    const parts = reference.pathname.split('/').filter(Boolean)
    const file = decodeURIComponent(parts[0] ?? '')
    if (!file) throw new Error('平台媒体标识无效')
    const groupFile = reference.hostname === 'group-file'
    const action = groupFile
      ? 'get_group_file_url'
      : segment.type === 'audio'
        ? 'get_record'
        : segment.type === 'image'
          ? 'get_image'
          : 'get_file'
    const result = record(
      await rpc(
        action,
        groupFile
          ? { group_id: message.chat.id, file_id: file, busid: Number(parts[1] ?? 0) }
          : { file, ...(segment.type === 'audio' ? { out_format: 'mp3' } : {}) },
        signal,
      ),
    )
    signal.throwIfAborted()
    filename ??= typeof result.file_name === 'string' ? result.file_name : undefined
    if (typeof result.base64 === 'string') {
      if (result.base64.length > Math.ceil(maxBytes / 3) * 4)
        throw new Error('媒体超过文件大小上限')
      const data = Buffer.from(result.base64, 'base64')
      if (data.byteLength > maxBytes) throw new Error('媒体超过文件大小上限')
      return {
        data,
        filename: filename ?? (segment.type === 'audio' ? '语音.mp3' : '媒体'),
        mimeType:
          segment.type === 'audio'
            ? 'audio/mpeg'
            : data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
              ? 'image/png'
              : data.subarray(0, 3).toString('hex') === 'ffd8ff'
                ? 'image/jpeg'
                : /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
                  ? 'image/gif'
                  : data.subarray(0, 4).toString() === 'RIFF' &&
                      data.subarray(8, 12).toString() === 'WEBP'
                    ? 'image/webp'
                    : 'application/octet-stream',
      }
    }
    if (typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url))
      throw new Error('平台未提供可下载的 URL 或二进制内容')
    url = result.url
  }
  // 平台返回的本地路径属于机器人主机，不能拿来读取本服务文件系统。
  return downloadHttpMedia(
    { ...segment, url, ...(filename ? { name: filename } : {}) },
    signal,
    maxBytes,
  )
}
