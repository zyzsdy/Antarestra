import type { Component } from 'vue'
import type { ClientContext } from '@antarestra/webui/client'

export interface AdminPage {
  /** 唯一标识，只使用小写字母、数字和短横线。 */
  id: string
  title: string
  group: string
  icon: string
  component: Component
  /** 附加的系统范围权限；服务端 API 仍必须独立鉴权。 */
  permission?: string
  order?: number
}
export const adminPagesSlot = 'admin-console.pages'
export function registerAdminPage(ctx: ClientContext, page: AdminPage): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(page.id)) throw new Error('后台页面标识无效')
  return ctx.contribute(adminPagesSlot, page.id, page)
}
