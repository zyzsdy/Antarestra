import { randomUUID } from 'node:crypto'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import type { UploadPlan, UploadedPart } from './client.js'
import type { DownloadResponse } from './response.js'
export { fileResponse } from './response.js'
export type { DownloadResponse } from './response.js'
export type { UploadPlan, UploadedPart } from './client.js'

export interface BlobUpload {
  key: string
  stagingKey: string
  size: number
  expiresAt: number
  multipartId?: string
  contentType?: string
}
export interface StorageBackend {
  begin(upload: BlobUpload): Promise<BlobUpload>
  plan(upload: BlobUpload): Promise<UploadPlan>
  /** 必须核验长度并封存对象，旧上传凭证不能修改已提交文件。可重复调用。 */
  complete(upload: BlobUpload, parts: UploadedPart[]): Promise<void>
  discard(upload: BlobUpload): Promise<void>
  remove(key: string): Promise<void>
  download(key: string, response?: DownloadResponse): Promise<string>
  read(key: string): Promise<Uint8Array>
  exists?(key: string): Promise<boolean>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    storage: StorageService
  }
}
export class StorageService extends Service {
  private backends = new Map<string, StorageBackend>()
  constructor(ctx: Context) {
    super(ctx, 'storage')
  }
  register(owner: Context, id: string, backend: StorageBackend) {
    this.ctx.fiber.assertActive()
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('存储后端标识无效')
    if (this.backends.has(id)) throw new Error('存储后端标识重复')
    let active = true
    const invoke = <T>(action: () => Promise<T>): Promise<T> => {
      this.ctx.fiber.assertActive()
      owner.fiber.assertActive()
      if (!active) throw new Error('存储后端已卸载')
      return action()
    }
    const guarded: StorageBackend = {
      begin: (upload) => invoke(() => backend.begin(upload)),
      plan: (upload) => invoke(() => backend.plan(upload)),
      complete: (upload, parts) => invoke(() => backend.complete(upload, parts)),
      discard: (upload) => invoke(() => backend.discard(upload)),
      remove: (key) => invoke(() => backend.remove(key)),
      download: (key, response) => invoke(() => backend.download(key, response)),
      read: (key) => invoke(() => backend.read(key)),
      ...(backend.exists ? { exists: (key: string) => invoke(() => backend.exists!(key)) } : {}),
    }
    owner.effect(() => {
      this.backends.set(id, guarded)
      return () => {
        active = false
        if (this.backends.get(id) === guarded) this.backends.delete(id)
      }
    })
  }
  backend(id: string): StorageBackend {
    this.ctx.fiber.assertActive()
    const backend = this.backends.get(id)
    if (!backend) throw new Error('存储后端尚未就绪')
    return backend
  }
  allocate(size: number, expiresAt: number): BlobUpload {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('对象大小无效')
    return {
      key: `objects/${randomUUID()}`,
      stagingKey: `uploads/${randomUUID()}`,
      size,
      expiresAt,
    }
  }
}
export default StorageService
