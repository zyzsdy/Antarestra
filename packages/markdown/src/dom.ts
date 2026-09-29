import morphdom from 'morphdom'
import { sanitizeHtml } from './sanitize.js'

/** 更新变化的文本和属性，保留已显示节点、选择区及扩展拥有的子树。 */
export function patchMarkdown(host: HTMLElement, html: string) {
  const target = host.cloneNode(false) as HTMLElement
  target.innerHTML = sanitizeHtml(html)
  morphdom(host, target, {
    childrenOnly: true,
    getNodeKey: (node) =>
      node instanceof Element ? (node.getAttribute('data-md-extension') ?? undefined) : undefined,
    onBeforeElUpdated: (from, to) => {
      if (
        from.hasAttribute('data-md-extension') &&
        from.getAttribute('data-md-extension') === to.getAttribute('data-md-extension')
      )
        return false
      return !from.isEqualNode(to)
    },
  })
}
