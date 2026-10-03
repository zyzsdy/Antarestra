import type { Context } from '@antarestra/plugin-sdk'

export type ChatType = 'private' | 'group'
export interface ChatTarget {
  type: ChatType
  id: string
}
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string }
  | { type: 'reply'; messageId: string }
  | { type: 'image' | 'file'; url: string; name?: string }
export interface IncomingMessage {
  id: string
  chat: ChatTarget
  sender: { id: string; name?: string; role?: 'owner' | 'admin' | 'member'; bot?: boolean }
  segments: readonly MessageSegment[]
  timestamp?: number
  chatName?: string
  /** 适配器验证引用的原消息确由本机器人发出后才设置。 */
  replyToBot?: boolean
}
export interface ActivationPolicy {
  /** 群聊动态回复作为独立或条件，不参与 mode 的全部匹配。 */
  dynamic?: DynamicReplyPolicy
  mode?: 'any' | 'all'
  always?: boolean
  mention?: boolean
  reply?: boolean
  prefixes?: string[]
  keywords?: string[]
  cooldownMs?: number
  maxPerMinute?: number
}
export interface DynamicReplyPolicy {
  baseProbability?: number
  hotProbability?: number
  hotDurationMs?: number
  maxSilentMessages?: number
}
export interface ChatPolicy {
  enabled?: boolean
  commands?: boolean
  ai?: boolean
  agentId?: string
  activation?: ActivationPolicy
  context?: 'activated' | 'recent'
  recentLimit?: number
  queueLimit?: number
}
export interface ChatAccessPolicy {
  mode: 'whitelist' | 'blacklist'
  ids: string[]
  defaults?: ChatPolicy
}
export interface ConnectionPolicy {
  enabled?: boolean
  defaults?: ChatPolicy
  private?: ChatAccessPolicy
  group?: ChatAccessPolicy
  chats?: Record<string, ChatPolicy>
}
export interface ConnectionDescriptor {
  id: string
  platform: string
  accountId: string
  tenantId?: string
  label?: string
  policy?: ConnectionPolicy
  capabilities?: readonly string[]
  send(
    target: ChatTarget,
    segments: readonly MessageSegment[],
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<{ messageId?: string }>
  getMember?(
    target: ChatTarget,
    userId: string,
  ): Promise<{ active: boolean; role?: 'owner' | 'admin' | 'member' }>
  invoke?(
    action: string,
    target: ChatTarget,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
}
export interface ConnectionSnapshot {
  id: string
  platform: string
  accountId: string
  tenantId?: string
  label?: string
  capabilities: readonly string[]
  status: 'connecting' | 'online' | 'offline' | 'error'
  error?: string
}
export interface ImIdentity {
  actorId: string
  workspaceId: string
  workspaceLabel: string
}
export interface IdentityInput {
  connection: ConnectionSnapshot
  message: IncomingMessage
}
export interface IdentityResolver {
  resolve(input: IdentityInput): Promise<ImIdentity>
  validate(identity: ImIdentity, input: IdentityInput): Promise<boolean>
  background(
    actorId: string,
    workspaceId: string,
  ): Promise<{ identity: ImIdentity; input: IdentityInput } | undefined>
}
export interface MessageContext extends ImIdentity {
  readonly connection: ConnectionSnapshot
  readonly message: IncomingMessage
  readonly policy: Readonly<ChatPolicy>
  readonly signal: AbortSignal
  /** 不可序列化的可信请求对象，直接传给 rbac/ai 的 im 来源。 */
  readonly request: object
  reply(
    segments: readonly MessageSegment[],
    options?: { idempotencyKey?: string },
  ): Promise<{ messageId?: string }>
}
export type HandlerResult = 'continue' | 'consumed' | 'rejected' | void
export interface MessageHandler {
  id: string
  stage: 'command' | 'message' | 'ai'
  handle(context: MessageContext): Promise<HandlerResult> | HandlerResult
}
export interface ConnectionHandle {
  receive(message: IncomingMessage): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }>
  setStatus(status: ConnectionSnapshot['status'], error?: string): void
}
export interface ScopedTarget {
  connectionId: string
  chat: ChatTarget
  workspaceId: string
}
export interface BackgroundIdentity extends ImIdentity {
  target: ScopedTarget
  senderId: string
}
export type Owner = Context
