import MarkdownIt from 'markdown-it'
import { katex as katexPlugin } from '@mdit/plugin-katex'
import { tasklist } from '@mdit/plugin-tasklist'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import dart from 'highlight.js/lib/languages/dart'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

import type { MarkdownIt as MarkdownItInstance, RendererRule } from 'markdown-it'

import type { MarkdownRenderer, MarkdownRendererOptions, MarkdownRenderContext } from './types.js'

for (const [name, language] of Object.entries({
  bash,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language)
}

const DEFAULT_LANG_LABEL = 'text'
const EXTERNAL_LINK_RE = /^(?:https?:)?\/\//i

type RenderRule = RendererRule

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"></rect><path d="M10.5 3.4V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.4"></path></svg>'

function highlightWithHljs(
  code: string,
  lang: string,
  escapeHtml: (value: string) => string,
): string {
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code)
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    // 单个代码块高亮失败时退回纯文本，不影响其余内容渲染。
    return escapeHtml(code)
  }
}

function createFenceRenderer(md: MarkdownItInstance, enableHighlight: boolean): RenderRule {
  const escapeHtml = md.utils.escapeHtml

  return (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    const info = token.info.trim()
    const lang = info.split(/\s+/)[0] ?? ''
    const context = env as unknown as MarkdownRenderContext & { source: string }
    const lines = context.source.split('\n')
    const lastLine = (token.map?.[1] ?? 0) - 1
    // AST 的代码正文不含开闭围栏；借助行数差判断，避免把缩进代码误当结束符。
    const contentLines = token.content
      ? token.content.split('\n').length - (token.content.endsWith('\n') ? 1 : 0)
      : 0
    const closed =
      lastLine - (token.map?.[0] ?? 0) > contentLines &&
      (!context.streaming || lastLine < lines.length - 1)
    const headerComplete = !context.streaming || (token.map?.[0] ?? 0) < lines.length - 1
    const custom = headerComplete
      ? context.fence?.({ language: lang, info, source: token.content, closed })
      : undefined
    if (custom !== undefined) return custom

    const body = enableHighlight
      ? highlightWithHljs(token.content, lang, escapeHtml)
      : escapeHtml(token.content)
    const langClass = lang ? ` language-${escapeHtml(lang)}` : ''

    return [
      '<div class="md-code">',
      '<div class="md-code-head">',
      `<span class="md-code-lang">${escapeHtml(lang || DEFAULT_LANG_LABEL)}</span>`,
      '<div class="md-code-actions">',
      `<button type="button" class="md-code-action md-code-copy">${COPY_ICON}<span class="md-code-label">复制</span></button>`,
      '</div>',
      '</div>',
      `<pre class="md-code-pre"><code class="hljs${langClass}">${body}</code></pre>`,
      '</div>\n',
    ].join('')
  }
}

function createLinkOpenRenderer(md: MarkdownItInstance): RenderRule {
  const fallback: RenderRule =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

  return (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const href = token?.attrGet('href')
    if (token && typeof href === 'string' && EXTERNAL_LINK_RE.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return fallback(tokens, idx, options, env, self)
  }
}

function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
}

export function createMarkdownRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
  const md = new MarkdownIt({
    html: options.html ?? false,
    linkify: options.linkify ?? true,
    typographer: false,
    breaks: false,
  })

  if (options.tasklist !== false) md.use(tasklist)
  if (options.math !== false) md.use(katexPlugin)

  md.renderer.rules.fence = createFenceRenderer(md, options.highlight !== false)
  md.renderer.rules.link_open = createLinkOpenRenderer(md)

  return {
    render(source: string, context: MarkdownRenderContext = {}): string {
      return wrapTables(md.render(source ?? '', { ...context, source }))
    },
    boundaries(source: string): number[] {
      const offsets = [0]
      for (let i = 0; i < source.length; i++) if (source[i] === '\n') offsets.push(i + 1)
      return [
        ...new Set(
          md
            .parse(source, {})
            .flatMap((token) =>
              token.level === 0 && token.map ? [offsets[token.map[0]] ?? 0] : [],
            ),
        ),
      ]
    },
  }
}
