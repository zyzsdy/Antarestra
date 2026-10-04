import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import { PhotoIcon } from '@antarestra/webui/icons'
import Page from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'im-stickers-lib',
    title: '表情包库',
    group: '机器人',
    icon: PhotoIcon,
    component: Page,
    permission: 'admin.im.stickers.manage',
    order: 62,
  })
}
export default apply
