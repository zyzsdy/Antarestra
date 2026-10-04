import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { ChatBubbleLeftRightIcon, ShieldCheckIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'
import HistoryPage from './HistoryPage.vue'
import CommandsPage from './CommandsPage.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'im-commands',
    title: '命令权限管理',
    group: '机器人',
    icon: ShieldCheckIcon,
    component: CommandsPage,
    permission: 'admin.im.commands.manage',
    order: 62,
  })
  registerAdminPage(ctx, {
    id: 'im-history',
    title: '群消息与 AI 会话',
    group: '机器人',
    icon: ChatBubbleLeftRightIcon,
    component: HistoryPage,
    permission: 'admin.im.history.view',
    order: 61,
  })
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
