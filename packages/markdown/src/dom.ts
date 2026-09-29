import morphdom from 'morphdom'
import { sanitizeHtml } from './sanitize.js'

/** 更新变化的文本和属性，保留已显示节点、选择区及扩展拥有的子树。 */
export function patchMarkdown(host: HTMLElement, html: string, extensionKeys = new Set<string>()) {
  const target = host.cloneNode(false) as HTMLElement
  target.innerHTML = sanitizeHtml(html)
  for (const node of target.querySelectorAll('[data-md-extension]')) {
    if (!extensionKeys.has(node.getAttribute('data-md-extension')!)) {
      node.removeAttribute('data-md-extension')
    }
  }
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
