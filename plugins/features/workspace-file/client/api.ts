import type { ClientContext } from '@antarestra/webui/client'
import type { UploadExecutor, UploadPlan } from '@antarestra/storage/client'
import { uploadSlot } from '@antarestra/storage/client'
export const filesSlot = 'workspace-file.client'
export function uploadPath(filename: string, directory = '/', date = new Date()): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  return (directory === '/' ? `/upload/${day}/` : directory + '/') + filename
}
export interface WorkspaceFilesClient {
  upload(
    file: File,
    path: string,
    signal: AbortSignal,
    progress?: (sent: number, total: number) => void,
  ): Promise<WorkspaceFileResource>
  uploadAttachment(
    file: File,
    signal: AbortSignal,
    progress?: (sent: number, total: number) => void,
  ): Promise<WorkspaceFileResource>
  remove(id: string, signal: AbortSignal): Promise<void>
}
export interface WorkspaceFileResource {
  id: string
  path: string
  filename: string
  mimeType: string
  size: number
  url: string
}
export function createFilesClient(ctx: ClientContext): WorkspaceFilesClient {
  async function api<T>(path: string, body: object, signal: AbortSignal): Promise<T> {
    const response = await fetch('/api/workspace-files' + path, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await response.json()
    if (!response.ok)
      throw new Error(typeof value.error === 'string' ? value.error : '文件操作失败，请重试')
    return value as T
  }
  async function upload(
    file: File,
    path: string,
    signal: AbortSignal,
    progress?: (sent: number, total: number) => void,
    attachment = false,
  ) {
    const ticket = await api<{ token: string; plan: UploadPlan }>(
      '/uploads',
      { path, size: file.size, attachment, mimeType: file.type },
      signal,
    )
    try {
      const executor = ctx.slot<UploadExecutor>(uploadSlot).get(ticket.plan.driver)
      if (!executor) throw new Error('上传适配器尚未加载，请刷新后重试')
      const parts = await executor(file, ticket.plan, signal, progress)
      return await api<WorkspaceFileResource>(
        `/uploads/${ticket.token}/complete`,
        { parts },
        signal,
      )
    } catch (error) {
      // 取消使用独立短时信号；原上传信号可能已由用户中断。
      await api(`/uploads/${ticket.token}/cancel`, {}, AbortSignal.timeout(5000)).catch(
        async () => {
          // 完成请求与取消竞争时，按上传 ID 删除已封存文件并释放配额。
          await api(`/resources/${ticket.token}/remove`, {}, AbortSignal.timeout(5000)).catch(
            () => {},
          )
        },
      )
      throw error
    }
  }
  return {
    upload,
    uploadAttachment: (file, signal, progress) => upload(file, file.name, signal, progress, true),
    async remove(id, signal) {
      await api(`/resources/${encodeURIComponent(id)}/remove`, {}, signal)
    },
  }
}
