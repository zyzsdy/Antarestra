import createDOMPurify from 'dompurify'

// 只允许正文排版属性；不允许定位、覆盖宿主界面或通过 CSS 请求外部资源。
// top / height 等也用于 KaTeX 的行内布局，定位本身由包内可信 CSS 提供。
const STYLE_PROPERTIES =
  /^(?:color|background-color|font-(?:family|size|style|weight|variant)|line-height|letter-spacing|word-spacing|text-(?:align|decoration|indent|transform)|white-space|word-break|overflow-wrap|vertical-align|width|min-width|max-width|height|min-height|max-height|top|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color|radius))?)$/
const STYLE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp'])

function sanitizeStyle(value: string): string {
  const style = document.createElement('span').style
  style.cssText = value
  for (const property of Array.from(style)) {
    const value = style.getPropertyValue(property)
    if (
      !STYLE_PROPERTIES.test(property) ||
      /[\\@<>]|\/\*/.test(value) ||
      [...value.matchAll(/([\w-]+)\s*\(/g)].some(
        (match) => !STYLE_FUNCTIONS.has(match[1]!.toLowerCase()),
      )
    ) {
      style.removeProperty(property)
    } else {
      // 不保留 !important，避免压过宿主的响应式约束。
      style.setProperty(property, value)
    }
  }
  return style.cssText
}

function safeUrl(value: string, image: boolean): boolean {
  try {
    const url = new URL(value, 'https://markdown.invalid/')
    return ['http:', 'https:', ...(image ? [] : ['mailto:', 'tel:'])].includes(url.protocol)
  } catch {
    return false
  }
}

function createSanitizer() {
  // 独立实例，避免影响 Mermaid 或宿主对 DOMPurify 的使用。
  const purifier = createDOMPurify(window)
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style') {
      data.attrValue = sanitizeStyle(data.attrValue)
      data.keepAttr = Boolean(data.attrValue)
    }
    if (['href', 'src', 'xlink:href'].includes(data.attrName)) {
      data.keepAttr = safeUrl(data.attrValue, data.attrName === 'src')
    }
  })
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName.toLowerCase() !== 'a') return
    const href = node.getAttribute('href')
    if (href && /^(?:https?:)?\/\//i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    } else {
      node.removeAttribute('target')
    }
  })
  return purifier
}

let sanitizer: ReturnType<typeof createSanitizer> | undefined

/** 保留常用 HTML、SVG / MathML 公式及受限内联样式，写入 DOM 前统一清洗。 */
export function sanitizeHtml(html: string): string {
  sanitizer ??= createSanitizer()
  return sanitizer.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcset', 'sizes', 'ping', 'autofocus'],
  })
}
