import type { IncomingMessage, MessageSegment } from '@antarestra/im'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : undefined
}

/** 仅接受数组消息，避免把 CQ 码字符串误当普通文本并失去 @ 的语义。 */
export function normalizeMessage(value: unknown, selfId: string): IncomingMessage | undefined {
  const event = record(value)
  if (event.post_type !== 'message' || id(event.self_id) !== selfId) return
  const senderId = id(event.user_id)
  const messageId = id(event.message_id)
  const type = event.message_type
  const chatId = type === 'group' ? id(event.group_id) : senderId
  if (!senderId || !messageId || !chatId || senderId === selfId) return
  if (type !== 'group' && type !== 'private') return
  if (!Array.isArray(event.message)) return
  const sender = record(event.sender)
  if (sender.is_bot === true || sender.bot === true) return
  const segments: MessageSegment[] = []
  for (const item of event.message) {
    const segment = record(item)
    const data = record(segment.data)
    if (segment.type === 'text' && typeof data.text === 'string')
      segments.push({ type: 'text', text: data.text })
    if (segment.type === 'at' && id(data.qq))
      segments.push({ type: 'mention', userId: id(data.qq)! })
    if (segment.type === 'reply' && id(data.id))
      segments.push({ type: 'reply', messageId: id(data.id)! })
    if ((segment.type === 'image' || segment.type === 'file') && typeof data.url === 'string')
      segments.push({
        type: segment.type,
        url: data.url,
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
      })
  }
  return {
    id: messageId,
    chat: { type, id: chatId },
    sender: {
      id: senderId,
      ...(typeof sender.card === 'string' && sender.card
        ? { name: sender.card }
        : typeof sender.nickname === 'string'
          ? { name: sender.nickname }
          : {}),
      role: sender.role === 'owner' || sender.role === 'admin' ? sender.role : 'member',
    },
    segments,
    ...(typeof event.time === 'number' ? { timestamp: event.time * 1000 } : {}),
  }
}

export function encodeMessage(segments: readonly MessageSegment[]) {
  return segments.map((segment) => {
    switch (segment.type) {
      case 'text':
        return { type: 'text', data: { text: segment.text } }
      case 'mention':
        return { type: 'at', data: { qq: segment.userId } }
      case 'reply':
        return { type: 'reply', data: { id: segment.messageId } }
      case 'image':
        return { type: 'image', data: { file: segment.url } }
      case 'file':
        throw new Error('OneBot 11 通用消息接口不支持文件发送')
    }
  })
}
