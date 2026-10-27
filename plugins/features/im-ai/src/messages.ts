import type { ActivationPolicy, MessageContext } from '@antarestra/im'
import type { ContentBlock, RunRecord } from '@antarestra/ai'

export function messageText(message: MessageContext) {
  return message.message.segments
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}
export function activationReason(
  message: MessageContext,
  activation?: ActivationPolicy,
  dynamic = false,
) {
  const text = messageText(message)
  if (!text && !message.message.segments.some((part) => 'url' in part)) return ''
  const rule =
    activation ??
    (message.message.chat.type === 'private'
      ? { always: true }
      : { mention: true, prefixes: ['/ai'] })
  const checks: boolean[] = []
  const reasons: string[] = []
  const check = (value: boolean, reason: string) => {
    checks.push(value)
    if (value) reasons.push(reason)
  }
  if (rule.always) check(true, '每条消息')
  if (rule.mention)
    check(
      message.message.segments.some(
        (part) => part.type === 'mention' && part.userId === message.connection.accountId,
      ),
      '被 at',
    )
  if (rule.reply) check(message.message.replyToBot === true, '回复或引用机器人')
  if (rule.prefixes?.length)
    check(
      rule.prefixes.some(
        (prefix) =>
          text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`),
      ),
      '命令',
    )
  if (rule.keywords?.length)
    check(
      rule.keywords.some((word) => word.length > 0 && text.includes(word)),
      '提到名字或关键词',
    )
  const ordinary =
    checks.length > 0 && (rule.mode === 'all' ? checks.every(Boolean) : checks.some(Boolean))
  return [...(ordinary ? reasons : []), ...(dynamic ? ['动态激活'] : [])].join('、')
}
export function activated(message: MessageContext, activation?: ActivationPolicy, dynamic = false) {
  return !!activationReason(message, activation, dynamic)
}
function isCommentary(block: ContentBlock) {
  if (block.type !== 'text' || !block.continuation) return false
  try {
    const signature: unknown = JSON.parse(block.continuation.signature)
    return (
      !!signature &&
      typeof signature === 'object' &&
      'v' in signature &&
      signature.v === 1 &&
      'phase' in signature &&
      signature.phase === 'commentary'
    )
  } catch {
    return false
  }
}

/** 从完整模型消息提取中间正文，不读取流式增量、思考或工具内容。 */
export function intermediateTexts(run: Pick<RunRecord, 'messages'>) {
  const last = run.messages.findLastIndex((message) => message.role === 'assistant')
  return run.messages.flatMap((message, index) => {
    if (
      message.role !== 'assistant' ||
      (message.stopReason && !['stop', 'toolUse'].includes(message.stopReason))
    )
      return []
    const intermediate =
      index !== last || message.content.some((block) => block.type === 'tool-call')
    const text = message.content
      .flatMap((block) =>
        block.type === 'text' && (intermediate || isCommentary(block)) ? [block.text] : [],
      )
      .join('\n')
      .trim()
    return text ? [{ id: message.id ?? `message-${index}`, text }] : []
  })
}

/** 只输出最后助理消息中位于最后一个思考/工具块之后的正文。 */
export function finalText(run: Pick<RunRecord, 'messages'>) {
  const content = run.messages.findLast((message) => message.role === 'assistant')?.content ?? []
  let start = 0
  content.forEach((block, index) => {
    if (
      isCommentary(block) ||
      ['thinking', 'tool-call', 'tool-result', 'provider-tool'].includes(block.type)
    )
      start = index + 1
  })
  return content
    .slice(start)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
}
