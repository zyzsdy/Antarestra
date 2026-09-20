import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { UserCircleIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'ai-agents',
    title: 'Agents',
    group: 'AI 设置',
    icon: UserCircleIcon,
    component: Page,
    permission: 'admin.ai.agents.manage',
    order: 40,
  })
}
export default apply
