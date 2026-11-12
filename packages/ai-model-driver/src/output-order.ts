import type { ContentBlock } from '@antarestra/ai'

/** 将 pi 的内容和它未保留的提供商工具按 Responses 原始输出顺序合并。 */
export function orderOutput(blocks: ContentBlock[], order: Map<string, number>): ContentBlock[] {
  const position = (block: ContentBlock) => {
    let id = 'id' in block ? block.id : ''
    if ((block.type === 'text' || block.type === 'thinking') && block.continuation) {
      const signature = block.continuation.signature
      try {
        const value = JSON.parse(signature) as { id?: unknown }
        if (typeof value?.id === 'string') id = value.id
      } catch {
        id = signature
      }
    }
    // pi 的函数调用 ID 由 call_id 和 output item id 组成。
    return order.get(id) ?? order.get(id.split('|').at(-1)!) ?? Number.MAX_SAFE_INTEGER
  }
  return blocks.toSorted((left, right) => position(left) - position(right))
}
