import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { Cog6ToothIcon, ArrowPathIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
import RestartPage from './RestartPage.vue'
const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'plugin-config-panel',
    title: '插件设置',
    group: '系统设置',
    icon: Cog6ToothIcon,
    component: Page,
    permission: 'admin.plugins.manage',
    order: 100,
  })
  registerAdminPage(ctx, {
    id: 'system-restart',
    title: '系统重启',
    group: '系统设置',
    icon: ArrowPathIcon,
    component: RestartPage,
    permission: 'admin.system.restart',
    order: 110,
  })
}
export default apply
