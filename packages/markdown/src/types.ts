export type MarkdownRendererOptions = {
  /** 是否允许原始 HTML（默认开启，DOM 输出前仍会经过 DOMPurify 清洗）。 */
  html?: boolean
  /** 是否自动识别裸 URL 为链接（默认开启）。 */
  linkify?: boolean
  /** 是否启用 highlight.js 代码高亮（默认开启）。 */
  highlight?: boolean
  /** 是否启用 KaTeX 数学公式（默认开启）。 */
  math?: boolean
  /** 是否启用任务列表（默认开启）。 */
  tasklist?: boolean
}

export type MarkdownRenderer = {
  /** 将一段 Markdown 渲染为 HTML 字符串（不含清洗步骤）。 */
  render: (source: string, context?: MarkdownRenderContext) => string
  /** 顶层 AST 节点的源文本偏移，用于保留稳定前缀。 */
  boundaries: (source: string) => number[]
}

export interface CodeNode {
  language: string
  info: string
  source: string
  /** 只有收到合法结束围栏才为 true，流结束不隐式补全围栏。 */
  closed: boolean
}

export interface MarkdownRenderContext {
  streaming?: boolean
  fence?: (node: CodeNode) => string | undefined
}

/** 纯功能包仅约定 DOM 生命周期，不依赖任何插件框架。 */
export interface CodeRenderer {
  supportsPartial: boolean
  mount(host: HTMLElement): {
    update(node: CodeNode): void
    dispose(): void
  }
}

export interface MarkdownChunk {
  id: number
  source: string
  streaming: boolean
}
