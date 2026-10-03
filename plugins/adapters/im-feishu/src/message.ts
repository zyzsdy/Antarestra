import type { IncomingMessage, MessageSegment } from '@antarestra/im'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function normalizeMessage(
  value: unknown,
  account: { appId: string; tenantId: string; botOpenId: string },
): IncomingMessage | undefined {
  const event = object(value)
  const sender = object(event.sender)
  const senderId = object(sender.sender_id).open_id
  const message = object(event.message)
  if (
    event.app_id !== account.appId ||
    (event.tenant_key ?? sender.tenant_key) !== account.tenantId
  )
    return
  if (
    sender.sender_type !== 'user' ||
    typeof senderId !== 'string' ||
    senderId === account.botOpenId
  )
    return
  if (typeof message.message_id !== 'string' || typeof message.chat_id !== 'string') return
  if (message.chat_type !== 'p2p' && message.chat_type !== 'group') return
  if (typeof message.content !== 'string') return
  let content: Record<string, unknown>
  try {
    content = object(JSON.parse(message.content))
  } catch {
    return
  }
  const segments: MessageSegment[] = []
  if (typeof message.parent_id === 'string' && message.parent_id)
    segments.push({ type: 'reply', messageId: message.parent_id })
  if (message.message_type === 'text' && typeof content.text === 'string') {
    let text = content.text
    const mentions = Array.isArray(message.mentions) ? message.mentions : []
    // 平台占位符按出现位置转换，保留命令参数顺序。
    while (text) {
      let selected: { index: number; key: string; userId: string } | undefined
      for (const raw of mentions) {
        const mention = object(raw)
        const userId = object(mention.id).open_id
        if (typeof mention.key !== 'string' || !mention.key || typeof userId !== 'string') continue
        const index = text.indexOf(mention.key)
        if (index >= 0 && (!selected || index < selected.index))
          selected = { index, key: mention.key, userId }
      }
      if (!selected) {
        segments.push({ type: 'text', text })
        break
      }
      if (selected.index > 0) segments.push({ type: 'text', text: text.slice(0, selected.index) })
      segments.push({ type: 'mention', userId: selected.userId })
      text = text.slice(selected.index + selected.key.length)
    }
  } else if (message.message_type === 'image' && typeof content.image_key === 'string') {
    segments.push({ type: 'image', url: `feishu://image/${encodeURIComponent(content.image_key)}` })
  } else if (message.message_type === 'file' && typeof content.file_key === 'string') {
    segments.push({
      type: 'file',
      url: `feishu://file/${encodeURIComponent(content.file_key)}`,
      ...(typeof content.file_name === 'string' ? { name: content.file_name } : {}),
    })
  } else return
  return {
    id: message.message_id,
    chat: { type: message.chat_type === 'p2p' ? 'private' : 'group', id: message.chat_id },
    sender: { id: senderId, role: 'member' },
    segments,
    ...(Number.isFinite(Number(message.create_time))
      ? { timestamp: Number(message.create_time) }
      : {}),
  }
}

const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

export function encodeMessage(segments: readonly MessageSegment[]): {
  msg_type: 'text' | 'image' | 'file'
  content: string
  replyId?: string
} {
  const replyId = segments.find((segment) => segment.type === 'reply')?.messageId
  const payload = segments.filter((segment) => segment.type !== 'reply')
  const media = payload.filter((segment) => segment.type === 'image' || segment.type === 'file')
  if (media.length) {
    if (payload.length !== 1) throw new Error('飞书文件或图片应单独发送')
    const segment = media[0]!
    if (segment.type !== 'image' && segment.type !== 'file') throw new Error('无效的媒体消息')
    const prefix = `feishu://${segment.type}/`
    if (!segment.url.startsWith(prefix)) throw new Error('飞书媒体发送需要平台已上传的资源键')
    const key = decodeURIComponent(segment.url.slice(prefix.length))
    if (!key) throw new Error('飞书媒体资源键不能为空')
    return {
      msg_type: segment.type,
      content: JSON.stringify({ [segment.type === 'image' ? 'image_key' : 'file_key']: key }),
      ...(replyId ? { replyId } : {}),
    }
  }
  const text = payload
    .map((segment) =>
      segment.type === 'text'
        ? escape(segment.text)
        : segment.type === 'mention'
          ? `<at user_id="${escape(segment.userId)}"></at>`
          : '',
    )
    .join('')
  if (!text || Buffer.byteLength(text) > 20000)
    throw new Error('飞书文本消息不能为空且不能超过 20000 字节')
  return { msg_type: 'text', content: JSON.stringify({ text }), ...(replyId ? { replyId } : {}) }
}
