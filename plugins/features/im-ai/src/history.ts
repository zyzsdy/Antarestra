import type { ArchivedMessage, ChatPolicy, IncomingMessage, MessageContext } from '@antarestra/im'
import type { UserInput } from '@antarestra/ai'
import { replyFormatGuide } from './reply.js'

export interface InputSnapshot {
  template: string
  history_message: string
  last_message: string
  active_reason: string
  im_status?: string
  attachments: NonNullable<UserInput['attachments']>
  replyFormat?: { append: boolean; guide: string }
}
const labels = { image: '图片', video: '视频', audio: '音频', file: '文件' }
export const defaultInputTemplate = (type: 'private' | 'group') =>
  type === 'group' ? '激活原因：{{active_reason}}\n{{history_message}}' : '{{last_message}}'
export function formatMessage(
  message: IncomingMessage,
  media: ArchivedMessage['media'],
  attached = new Map<string, number>(),
) {
  return message.segments
    .map((segment, index) => {
      if (segment.type === 'text') return segment.text
      if (segment.type === 'mention') return `[@,${segment.userId}]`
      if (segment.type === 'reply') return `[引用,${segment.messageId}]`
      if (segment.type === 'forward') return `[合并转发,${segment.id}]`
      if (segment.type === 'unsupported') return `[${segment.name}]`
      const file = media.find((file) => file.index === index)
      const id = file?.resource?.resourceId ?? file?.id ?? `${message.id}:${index}`
      const attachment = attached.get(id)
      return `[${labels[segment.type]}${attachment ? `（附件${attachment}）` : ''},${id}]`
    })
    .join('')
}
function withSender(message: IncomingMessage, content: string) {
  return `发言者 ${JSON.stringify({ id: message.sender.id, name: message.sender.name ?? message.sender.id, messageId: message.id, ...(message.timestamp !== undefined ? { time: new Date(message.timestamp).toISOString() } : {}) })}：\n${content}`
}
export function prepareInput(
  message: MessageContext,
  history: ArchivedMessage[],
  policy: Readonly<ChatPolicy>,
  reason: string,
  templateUsage?: string,
  modelInput?: readonly string[],
): InputSnapshot {
  const template = policy.userInputTemplate ?? defaultInputTemplate(message.message.chat.type)
  const uses = (name: string) =>
    new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(templateUsage ?? template)
  const candidates = [
    ...(uses('history_message') ? history : []),
    ...(uses('last_message') && message.archived ? [message.archived] : []),
  ]
  const unique = [
    ...new Map(
      candidates.flatMap((message) => message.media).map((file) => [file.id, file]),
    ).values(),
  ]
  const attachments: InputSnapshot['attachments'] = []
  let images = 0,
    files = 0
  for (const media of unique.reverse()) {
    if (attachments.length >= 20) break
    const resource = media.resource
    if (!resource || media.status !== 'stored' || resource.size > 16 * 1024 * 1024) continue
    if (media.type === 'image') {
      if (modelInput && !modelInput.includes('image')) continue
      if (
        !/^image\/(png|jpeg|gif|webp)$/.test(resource.mimeType) ||
        images >= (policy.maxImages ?? 5)
      )
        continue
      images++
    } else {
      if (modelInput && !modelInput.includes('file')) continue
      if (files >= (policy.maxFiles ?? 5)) continue
      files++
    }
    attachments.unshift({ ...resource, type: media.type === 'image' ? 'image' : 'file' })
  }
  const attached = new Map(attachments.map((file, index) => [file.resourceId, index + 1]))
  return {
    template,
    replyFormat: {
      append: policy.appendReplyFormat === true,
      guide: replyFormatGuide(message.connection.capabilities),
    },
    history_message: history
      .map((entry) =>
        withSender(entry.message, formatMessage(entry.message, entry.media, attached)),
      )
      .join('\n\n'),
    last_message: withSender(
      message.message,
      formatMessage(message.message, message.archived?.media ?? [], attached),
    ),
    active_reason: reason,
    attachments,
  }
}
export function renderInput(snapshot: InputSnapshot) {
  return snapshot.template.replace(
    /\{\{\s*(history_message|last_message|active_reason|im_status)\s*\}\}/g,
    (_match, key: 'history_message' | 'last_message' | 'active_reason' | 'im_status') =>
      snapshot[key] ?? '',
  )
}
export async function refreshAttachments(
  snapshot: InputSnapshot,
  available: (id: string) => Promise<boolean>,
) {
  const attachments: InputSnapshot['attachments'] = []
  for (const file of snapshot.attachments)
    if (await available(file.resourceId)) attachments.push(file)
  if (attachments.length === snapshot.attachments.length) return snapshot
  const indices = new Map(attachments.map((file, index) => [file.resourceId, index + 1]))
  const update = (text: string) =>
    text.replace(
      /\[(图片|视频|音频|文件)（附件\d+）,([^\]]+)\]/g,
      (_match, type: string, id: string) =>
        `[${type}${indices.has(id) ? `（附件${indices.get(id)}）` : ''},${id}]`,
    )
  return {
    ...snapshot,
    attachments,
    history_message: update(snapshot.history_message),
    last_message: update(snapshot.last_message),
  }
}
