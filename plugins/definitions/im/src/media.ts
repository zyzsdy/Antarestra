import type { MediaSegment } from './types.js'

/** 平台返回的下载地址；不读取本地路径或执行非 HTTP 协议。 */
export async function downloadHttpMedia(
  segment: MediaSegment,
  signal: AbortSignal,
  maxBytes: number,
) {
  const url = new URL(segment.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('媒体下载地址无效')
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
  if (!response.ok || !response.body) throw new Error('媒体下载失败')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('媒体超过空间单文件上限')
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) throw new Error('媒体超过空间单文件上限')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const mimeType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
  const extension =
    (
      {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'audio/mpeg': '.mp3',
      } as Record<string, string>
    )[mimeType] ?? ''
  return {
    data: Buffer.concat(chunks),
    mimeType,
    filename: segment.name || `${segment.type}${extension}`,
  }
}
