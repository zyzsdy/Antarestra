import { defineComponent, h } from 'vue'
import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { CircleStackIcon } from '@antarestra/webui/icons'
import { createFilesClient, filesSlot } from './api.js'
import Page from './Page.vue'
import AdminPage from './AdminPage.vue'
const apply: ClientPlugin = (ctx) => {
  const files = createFilesClient(ctx)
  ctx.contribute(filesSlot, 'default', files)
  ctx.page({
    path: '/files/',
    name: '工作空间文件',
    component: defineComponent(() => () => h(Page, { files })),
  })
  registerAdminPage(ctx, {
    id: 'storage',
    title: '存储配额',
    group: '系统管理',
    icon: CircleStackIcon,
    component: AdminPage,
    permission: 'admin.storage.manage',
    order: 50,
  })
}
export default apply
