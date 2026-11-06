import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { ServerStackIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'mcp',
    title: 'MCP 服务器',
    group: 'AI 设置',
    icon: ServerStackIcon,
    component: Page,
    permission: 'admin.ai.mcp.manage',
    order: 50,
  })
}
export default apply
