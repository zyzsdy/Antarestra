/** 上传协议由实现插件解释；核心与业务插件不依赖 S3 SDK。 */
export interface UploadPlan {
  driver: string
  parts: { number: number; url: string; offset: number; size: number }[]
  headers: Record<string, string>
}
export interface UploadedPart {
  number: number
  etag: string
}
export type UploadExecutor = (
  file: Blob,
  plan: UploadPlan,
  signal: AbortSignal,
  progress?: (sent: number, total: number) => void,
) => Promise<UploadedPart[]>
export const uploadSlot = 'storage.uploaders'
