import type { ClientPlugin } from '@antarestra/webui/client'
import { defineComponent, h } from 'vue'
import { MarkdownContent } from '@antarestra/markdown'
import type { CodeRenderer } from '@antarestra/markdown'
import { markdownCodeSlot, markdownServiceSlot } from './api.js'
import type { MarkdownRenderService } from './api.js'

const apply: ClientPlugin = (ctx) => {
  const extensions = ctx.slot<CodeRenderer>(markdownCodeSlot)
  const component = defineComponent({
    props: { source: { type: String, required: true }, streaming: Boolean },
    setup: (props) => () => h(MarkdownContent, { ...props, extensions }),
  })
  ctx.contribute<MarkdownRenderService>(markdownServiceSlot, 'default', { component })
}
export default apply
