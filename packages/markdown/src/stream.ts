import { createMarkdownRenderer } from './markdown.js'
import type { MarkdownChunk, MarkdownRenderer } from './types.js'

/** 每个消息单独创建。追加只解析最后一个未稳定的顶层 AST 块。 */
export function createMarkdownStream(renderer: MarkdownRenderer = createMarkdownRenderer()) {
  let previous = ''
  let chunks: MarkdownChunk[] = []
  let ended = false
  return {
    update(source: string, streaming = true): readonly MarkdownChunk[] {
      if (source === previous && ended === !streaming) return chunks
      if (!source.startsWith(previous) || ended) chunks = []
      const tail = chunks.at(-1)
      const start = tail?.id ?? 0
      const prefix = chunks.slice(0, -1)
      const pending = source.slice(start)
      const boundaries = renderer
        .boundaries(pending)
        .filter(
          (offset, index) =>
            index === 0 ||
            !streaming ||
            pending.indexOf('\n', offset) !== -1 ||
            !/^ {0,3}(?:[-+*]|\d{1,9}[.)]?)$/.test(pending.slice(offset)),
        )
      // 引用定义等不生成可见节点的源文本也留在所属块内。
      if (boundaries.length) boundaries[0] = 0
      chunks = prefix.concat(
        boundaries.map((offset, index) => {
          const id = start + offset
          const text = pending.slice(offset, boundaries[index + 1])
          const active = streaming && index === boundaries.length - 1
          if (tail?.id === id && tail.source === text && tail.streaming === active) return tail
          return { id, source: text, streaming: active }
        }),
      )
      previous = source
      ended = !streaming
      return chunks
    },
  }
}
