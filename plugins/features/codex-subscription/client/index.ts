import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { CpuChipIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'codex-subscription',
    title: 'ChatGPT 订阅',
    group: 'AI 设置',
    icon: CpuChipIcon,
    component: Page,
    permission: 'admin.ai.codex.manage',
    order: 35,
  })
}
export default apply
