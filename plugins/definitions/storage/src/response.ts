export interface DownloadResponse {
  contentDisposition: string
  contentType?: string
}

const inlineTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/ogg',
  'video/webm',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
])

/** 仅允许无主动执行能力的类型内联，未知类型使用二进制附件。 */
export function fileResponse(type = 'application/octet-stream') {
  const contentType = type.trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType))
    return { contentType: 'application/octet-stream', contentDisposition: 'attachment' }
  return {
    contentType,
    contentDisposition: inlineTypes.has(contentType) ? 'inline' : 'attachment',
  }
}
