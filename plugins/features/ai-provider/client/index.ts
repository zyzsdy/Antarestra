import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { CpuChipIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'ai-providers',
    title: '提供商接入',
    group: 'AI 设置',
    icon: CpuChipIcon,
    component: Page,
    permission: 'admin.ai.providers.manage',
    order: 30,
  })
}
export default apply
