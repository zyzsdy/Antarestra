import type { ClientPlugin } from '@antarestra/webui/client'
import { markup } from './markup.js'
import { style } from './style.js'
import { mountAccount } from './account.js'

const apply: ClientPlugin = (ctx) => {
  const { h, ref, onMounted, onUnmounted, defineComponent } = ctx.vue
  const component = defineComponent({
    setup() {
      const element = ref<HTMLElement>()
      const controller = new AbortController()
      onMounted(() => {
        const root = element.value!.attachShadow({ mode: 'open' })
        const css = document.createElement('style')
        css.textContent = style
        const main = document.createElement('main')
        main.innerHTML = markup(ctx.config.allowRegistration === true)
        root.append(css, main)
        mountAccount(root, String(ctx.config.base), controller.signal)
      })
      onUnmounted(() => controller.abort())
      return () => h('div', { ref: element })
    },
  })
  ctx.page({ path: String(ctx.config.path), name: String(ctx.config.title), component })
}
export default apply
