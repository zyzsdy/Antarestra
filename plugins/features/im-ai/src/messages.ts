import type { ActivationPolicy, MessageContext } from '@antarestra/im'
import type { RunRecord } from '@antarestra/ai'

export function messageText(message: MessageContext) {
  return message.message.segments
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}
export function activated(message: MessageContext, activation?: ActivationPolicy, dynamic = false) {
  const text = messageText(message)
  if (!text) return false
  const rule =
    activation ??
    (message.message.chat.type === 'private'
      ? { always: true }
      : { mention: true, prefixes: ['/ai'] })
  const checks: boolean[] = []
  if (rule.always) checks.push(true)
  if (rule.mention)
    checks.push(
      message.message.segments.some(
        (part) => part.type === 'mention' && part.userId === message.connection.accountId,
      ),
    )
  if (rule.reply) checks.push(message.message.replyToBot === true)
  if (rule.prefixes?.length)
    checks.push(
      rule.prefixes.some(
        (prefix) =>
          text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`),
      ),
    )
  if (rule.keywords?.length)
    checks.push(rule.keywords.some((word) => word.length > 0 && text.includes(word)))
  return (
    dynamic ||
    (checks.length > 0 && (rule.mode === 'all' ? checks.every(Boolean) : checks.some(Boolean)))
  )
}
export function inputText(message: MessageContext, activation?: ActivationPolicy) {
  let text = messageText(message)
  for (const prefix of activation?.prefixes ?? ['/ai']) {
    if (text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\n`)) {
      text = text.slice(prefix.length).trim()
      break
    }
  }
  return text
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
