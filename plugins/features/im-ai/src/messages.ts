import type { ActivationPolicy, MessageContext } from '@antarestra/im'
import type { RunRecord } from '@antarestra/ai'

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
/** 只输出最后助理消息中位于最后一个思考/工具块之后的正文。 */
export function finalText(run: Pick<RunRecord, 'messages'>) {
  const content = run.messages.findLast((message) => message.role === 'assistant')?.content ?? []
  let start = 0
  content.forEach((block, index) => {
    let commentary = false
    if (block.type === 'text' && block.continuation) {
      try {
        const signature: unknown = JSON.parse(block.continuation.signature)
        commentary =
          !!signature &&
          typeof signature === 'object' &&
          'v' in signature &&
          signature.v === 1 &&
          'phase' in signature &&
          signature.phase === 'commentary'
      } catch {
        /* 非 JSON 签名不改变正文语义。 */
      }
    }
    if (
      commentary ||
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
