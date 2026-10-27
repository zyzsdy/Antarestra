import type { ContentBlock, MessageNode, SteeringMessage } from '@antarestra/contracts'

/** 引导输入与助理输出共用消息时间线，不生成新的服务端分支节点。 */
export function turnMessages(
  node: MessageNode,
  content: ContentBlock[],
  steering: SteeringMessage[],
) {
  const result: {
    node: MessageNode
    start: number
    end: number
    steering: boolean
    partial: boolean
  }[] = []
  let start = 0
  let key = node.id
  for (const entry of steering) {
    const end = Math.max(start, Math.min(content.length, entry.position ?? content.length))
    if (end > start)
      result.push({
        node: { ...node, id: key, content: content.slice(start, end) },
        start,
        end,
        steering: false,
        partial: true,
      })
    result.push({
      node: {
        ...node,
        id: entry.id,
        role: 'user',
        createdAt: entry.createdAt,
        input: entry.input,
        content: [{ type: 'text', text: entry.input.text }, ...(entry.input.attachments ?? [])],
      },
      start: end,
      end,
      steering: true,
      partial: false,
    })
    key = `${node.id}:after:${entry.id}`
    start = end
  }
  result.push({
    node: { ...node, id: key, content: content.slice(start) },
    start,
    end: content.length,
    steering: false,
    partial: false,
  })
  return result
}
