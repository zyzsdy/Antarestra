import DOMPurify from 'dompurify'

/**
 * 渲染结果清洗：markdown-it 允许原始 HTML 时，输出必须先经过 DOMPurify。
 * target / rel 是外链规则额外写入的属性，需要显式加入白名单。
 */
const SANITIZE_CONFIG = {
  ADD_ATTR: ['target', 'rel'],
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}
