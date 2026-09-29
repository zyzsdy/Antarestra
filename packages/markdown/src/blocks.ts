import { createMarkdownRenderer } from './markdown.js'

/** 按同一解析器的顶层 AST 切分；流式调用请使用 createMarkdownStream。 */
export function splitBlocks(source: string): string[] {
  const starts = createMarkdownRenderer().boundaries(source)
  if (starts.length) starts[0] = 0
  return starts.map((start, index) => source.slice(start, starts[index + 1]))
}
