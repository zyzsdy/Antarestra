import type { ClientPlugin } from '@antarestra/webui/client'
import Page from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  ctx.page({ path: '/__NAME__/', name: '新页面', component: Page })
}
export default apply
