import morphdom from 'morphdom'
import { sanitizeHtml } from './sanitize.js'

// 区分源码的默认状态和用户交互状态；弱引用不延长已卸载节点的生命周期。
const detailsDefaults = new WeakMap<Element, boolean>()

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
      if (from.localName === 'details' && to.localName === 'details') {
        const open = to.hasAttribute('open')
        if (detailsDefaults.get(from) === open) {
          to.toggleAttribute('open', from.hasAttribute('open'))
        }
        detailsDefaults.set(from, open)
      }
      return !from.isEqualNode(to)
    },
  })
  for (const details of host.querySelectorAll('details')) {
    if (!detailsDefaults.has(details)) {
      detailsDefaults.set(details, details.hasAttribute('open'))
    }
  }
}
