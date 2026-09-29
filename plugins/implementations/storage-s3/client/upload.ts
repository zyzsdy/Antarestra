import type { UploadExecutor, UploadedPart } from '@antarestra/storage/client'
export const upload: UploadExecutor = async (file, plan, signal, progress) => {
  const parts: UploadedPart[] = []
  let sent = 0
  for (const part of plan.parts) {
    const response = await fetch(part.url, {
      method: 'PUT',
      body: file.slice(part.offset, part.offset + part.size),
      headers: plan.headers,
      signal,
      credentials: 'omit',
    }).catch((error) => {
      if (signal.aborted) throw new Error('上传已取消')
      throw new Error('无法连接存储服务器，请检查网络、CORS 和页面连接策略', { cause: error })
    })
    if (!response.ok) throw new Error(`上传失败（${response.status}），请取消后重试`)
    const etag = response.headers.get('etag')
    if (!etag) throw new Error('存储服务器未暴露 ETag，请检查 CORS 配置')
    parts.push({ number: part.number, etag })
    sent += part.size
    progress?.(sent, file.size)
  }
  return parts
}
