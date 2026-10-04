import MarkdownIt, { type Env } from 'markdown-it'

interface Link {
  start: number
  end: number
  label: string
}
interface LinkContext extends Env {
  source: string
  links: Link[]
}

const markdown = new MarkdownIt({ html: false, linkify: false })
// 从公开规则接口取得原有链接解析器，继续复用 Markdown 的括号、转义和标题规则。
markdown.inline.ruler.enableOnly(['link'])
const parseLink = markdown.inline.ruler.getRules('')[0]!
markdown.inline.ruler.enable(['text', 'newline', 'escape', 'backticks', 'image'])
markdown.inline.ruler.at('link', (state, silent) => {
  const context = state.env as Partial<LinkContext>
  if (silent || state.src !== context.source || !context.links) return parseLink(state, silent)
  if (state.src[state.pos] !== '[') return false
  const start = state.pos
  const labelEnd = markdown.helpers.parseLinkLabel(state, start, true)
  const tokenStart = state.tokens.length
  if (!parseLink(state, silent)) return false
  const link = state.tokens.slice(tokenStart).find((token) => token.type === 'link_open')
  const href = link?.attrGet('href')
  if (typeof href === 'string' && /^https?:\/\//i.test(href))
    context.links.push({ start, end: state.pos, label: state.src.slice(start + 1, labelEnd) })
  return true
})

function filterInline(source: string) {
  const context: LinkContext = { source, links: [] }
  markdown.inline.parse(source, markdown, context, [])
  const { links } = context
  let result = ''
  let offset = 0
  for (let index = 0; index < links.length; index++) {
    const link = links[index]!
    let start = link.start
    let end = link.end
    let label = link.label
    // 括号中只有一个或多个引用链接时，连同括号和分隔符一起移除。
    const opening = /[（(][ \t]*$/.exec(source.slice(offset, start))
    if (opening) {
      let last = index
      while (
        links[last + 1] &&
        /^[\s,，、;；]*$/.test(source.slice(links[last]!.end, links[last + 1]!.start))
      )
        last++
      const closing = /^[ \t]*[)）]/.exec(source.slice(links[last]!.end))
      if (
        closing &&
        ((opening[0][0] === '(' && closing[0].endsWith(')')) ||
          (opening[0][0] === '（' && closing[0].endsWith('）')))
      ) {
        start = offset + opening.index
        while (start > offset && /[ \t]/.test(source[start - 1]!)) start--
        end = links[last]!.end + closing[0].length
        label = ''
        index = last
      }
    }
    // 数字引用和以 URL/域名作为标题的来源链接无需留下仍可能可点击的标题。
    if (/^(?:\d+|https?:\/\/\S+|(?:[\w-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?)$/i.test(label.trim()))
      label = ''
    result += source.slice(offset, start) + label
    offset = end
  }
  return result + source.slice(offset)
}

/** 仅过滤正文中的 Markdown HTTP(S) 链接，保留代码、裸链接及图片语法。 */
export function filterCitationLinks(source: string) {
  // 块级代码的源行范围由同一 Markdown 解析器识别，避免改写代码里的链接示例。
  const lineOffsets = [0]
  for (const match of source.matchAll(/\r\n?|\n/g)) lineOffsets.push(match.index + match[0].length)
  const blocks = markdown.parse(source, {})
  let result = ''
  let offset = 0
  for (const token of blocks) {
    if (!token.map || !['fence', 'code_block'].includes(token.type)) continue
    const start = lineOffsets[token.map[0]] ?? source.length
    const end = lineOffsets[token.map[1]] ?? source.length
    result += filterInline(source.slice(offset, start)) + source.slice(start, end)
    offset = end
  }
  return result + filterInline(source.slice(offset))
}
