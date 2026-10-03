import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { ChatBubbleLeftRightIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'im-console',
    title: 'IM 接入',
    group: '机器人',
    icon: ChatBubbleLeftRightIcon,
    component: Page,
    permission: 'admin.im.manage',
    order: 60,
  })
}
export default apply
