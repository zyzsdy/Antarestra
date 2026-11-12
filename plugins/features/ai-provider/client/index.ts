import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { CpuChipIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
import CodexPage from './CodexPage.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'codex-subscription',
    title: 'ChatGPT 订阅',
    group: 'AI 设置',
    icon: CpuChipIcon,
    component: CodexPage,
    permission: 'admin.ai.codex.manage',
    order: 35,
  })
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
