import type { ContentBlock } from '@antarestra/contracts'
import type { ToolDetail } from './tool-details.js'

export type ReplyDetail =
  | { id: string; type: 'text' | 'thinking'; text: string }
  | { id: string; type: 'tool'; tool: ToolDetail }

function commentary(block: ContentBlock) {
  if (block.type !== 'text' || !block.continuation) return false
  // 兼容已保存的 Responses 文字签名；旧驱动虽丢失工具顺序，仍保留了消息阶段。
  try {
    const signature = JSON.parse(block.continuation.signature)
    return signature?.v === 1 && signature.phase === 'commentary'
  } catch {
    return false
  }
}

/** 最后一个思考或调用之后的文字才是正文；此前的说明保留在原位置。 */
export function replyContent(blocks: ContentBlock[], tools: ToolDetail[]) {
  const boundary = blocks.findLastIndex(
    (block) =>
      block.type === 'thinking' ||
      block.type === 'tool-call' ||
      block.type === 'provider-tool' ||
      commentary(block),
  )
  const details: ReplyDetail[] = []
  const seen = new Set<string>()
  let body = ''
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text' && index > boundary) body += block.text
    else if (block.type === 'text' || block.type === 'thinking') {
      const previous = details.at(-1)
      if (previous?.type === block.type) previous.text += block.text
      else if (block.text)
        details.push({ id: `block-${index}`, type: block.type, text: block.text })
    } else if (block.type === 'tool-call' || block.type === 'provider-tool') {
      const tool = tools.find((item) => item.id === block.id)
      if (tool && !seen.has(tool.id)) {
        seen.add(tool.id)
        details.push({ id: `tool-${tool.id}`, type: 'tool', tool })
      }
    }
  }
  // 兼容中断运行只有调用事件、没有完整消息的记录。
  for (const tool of tools) {
    if (!seen.has(tool.id)) details.push({ id: `tool-${tool.id}`, type: 'tool', tool })
  }
  return { body, details }
}
