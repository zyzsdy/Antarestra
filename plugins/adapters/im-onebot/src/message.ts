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

const decodeCq = (value: string) =>
  value
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&#44;', ',')
    .replaceAll('&amp;', '&')
function parseCq(text: string) {
  const result: { type: string; data: Record<string, string> }[] = []
  let position = 0
  for (const match of text.matchAll(/\[CQ:([\w-]+)(?:,([^\]]*))?\]/g)) {
    if (match.index > position)
      result.push({ type: 'text', data: { text: decodeCq(text.slice(position, match.index)) } })
    result.push({
      type: match[1]!,
      data: Object.fromEntries(
        (match[2] ?? '')
          .split(',')
          .filter(Boolean)
          .map((part) => {
            const split = part.indexOf('=')
            return [part.slice(0, split), decodeCq(part.slice(split + 1))]
          }),
      ),
    })
    position = match.index + match[0].length
  }
  if (position < text.length)
    result.push({ type: 'text', data: { text: decodeCq(text.slice(position)) } })
  return result
}
/** 数组与 CQ 字符串都保留结构，不能把 CQ @ 当作普通文本。 */
export function normalizeMessage(value: unknown, selfId: string): IncomingMessage | undefined {
  const event = record(value)
  if (id(event.self_id) !== selfId) return
  if (event.post_type === 'notice' && event.notice_type === 'group_upload') {
    const file = record(event.file)
    const groupId = id(event.group_id),
      senderId = id(event.user_id),
      fileId = id(file.id)
    if (!groupId || !senderId || !fileId) return
    return {
      id: `upload:${fileId}`,
      chat: { type: 'group', id: groupId },
      sender: { id: senderId },
      segments: [
        {
          type: 'file',
          url:
            typeof file.url === 'string'
              ? file.url
              : `onebot://group-file/${encodeURIComponent(fileId)}/${id(file.busid) ?? '0'}`,
          ...(typeof file.name === 'string' ? { name: file.name } : {}),
        },
      ],
      ...(typeof event.time === 'number' ? { timestamp: event.time * 1000 } : {}),
      raw: event,
    }
  }
  if (event.post_type !== 'message' && event.post_type !== 'message_sent') return
  const senderId = id(event.user_id)
  const messageId = id(event.message_id)
  const type = event.message_type
  const chatId = type === 'group' ? id(event.group_id) : senderId
  if (!senderId || !messageId || !chatId) return
  if (type !== 'group' && type !== 'private') return
  const segments = normalizeSegments(event.message)
  if (!segments) return
  const sender = record(event.sender)
  return {
    id: messageId,
    chat: { type, id: chatId },
    sender: {
      id: senderId,
      ...(senderId === selfId || sender.is_bot === true || sender.bot === true
        ? { bot: true }
        : {}),
      ...(typeof sender.card === 'string' && sender.card
        ? { name: sender.card }
        : typeof sender.nickname === 'string'
          ? { name: sender.nickname }
          : {}),
      role: sender.role === 'owner' || sender.role === 'admin' ? sender.role : 'member',
    },
    segments,
    raw: event,
    ...(typeof event.time === 'number' ? { timestamp: event.time * 1000 } : {}),
  }
}

export function normalizeSegments(message: unknown): MessageSegment[] | undefined {
  const parts = Array.isArray(message)
    ? message
    : typeof message === 'string'
      ? parseCq(message)
      : undefined
  if (!parts) return
  const segments: MessageSegment[] = []
  for (const item of parts) {
    const segment = record(item)
    const data = record(segment.data)
    if (segment.type === 'text' && typeof data.text === 'string')
      segments.push({ type: 'text', text: data.text })
    if (segment.type === 'at' && id(data.qq))
      segments.push({ type: 'mention', userId: id(data.qq)! })
    if (segment.type === 'reply' && id(data.id))
      segments.push({ type: 'reply', messageId: id(data.id)! })
    if (segment.type === 'forward' && id(data.id))
      segments.push({ type: 'forward', id: id(data.id)! })
    if (
      ['image', 'file', 'video', 'record'].includes(String(segment.type)) &&
      (typeof data.url === 'string' || typeof data.file === 'string' || id(data.file_id))
    )
      segments.push({
        type: segment.type === 'record' ? 'audio' : (segment.type as 'image' | 'file' | 'video'),
        url:
          typeof data.url === 'string' && data.url
            ? data.url
            : typeof data.file === 'string' && /^https?:\/\//i.test(data.file)
              ? data.file
              : `onebot://file/${encodeURIComponent(id(data.file_id) ?? String(data.file))}`,
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
      })
    if (
      !['text', 'at', 'reply', 'forward', 'image', 'file', 'video', 'record'].includes(
        String(segment.type),
      )
    )
      segments.push({ type: 'unsupported', name: String(segment.type) })
  }
  return segments
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
      case 'video':
        return { type: 'video', data: { file: segment.url } }
      case 'audio':
        return { type: 'record', data: { file: segment.url } }
      case 'unsupported':
      case 'forward':
        throw new Error('不支持发送此消息类型')
      case 'file':
        throw new Error('OneBot 11 通用消息接口不支持文件发送')
    }
  })
}
