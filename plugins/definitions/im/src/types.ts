import type { Context } from '@antarestra/plugin-sdk'
import type { RunRecord } from '@antarestra/contracts'

export interface GroupSummary {
  workspaceId: string
  connectionId: string
  platform: string
  chatId: string
  name: string
  lastMessageAt: number | null
}
export interface AiHistoryEntry {
  id: string
  conversationId: string | null
  runId: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  delivery: 'pending' | 'sent' | 'failed' | 'unknown'
  createdAt: number
  inputPreview: string
  hasAnswer: boolean
}
export interface AiHistoryDetail extends AiHistoryEntry {
  input: string
  answer: string | null
  run: Pick<RunRecord, 'status' | 'model' | 'messages' | 'requests' | 'error' | 'endedAt'> | null
}
/** 可信服务端只读扩展；HTTP 消费方必须先校验管理权限与群空间。 */
export interface AiHistoryReader {
  list(
    workspaceId: string,
    offset: number,
    limit: number,
  ): Promise<{ entries: AiHistoryEntry[]; total: number; currentConversationId: string | null }>
  detail(workspaceId: string, id: string): Promise<AiHistoryDetail | undefined>
}

export type ChatType = 'private' | 'group'
export interface ChatTarget {
  type: ChatType
  id: string
}
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string }
  | { type: 'reply'; messageId: string }
  | { type: 'forward'; id: string }
  | MediaSegment
  | { type: 'unsupported'; name: string }
export interface MediaSegment {
  type: 'image' | 'video' | 'audio' | 'file'
  url: string
  name?: string
}
export interface ImageResource {
  resourceId: string
  mimeType: string
  filename: string
  size: number
}
/** 仅由服务端调用；空间来自已验证的发送目标，不接受模型传入空间。 */
export interface ImageResourceResolver {
  inspect(workspaceId: string, resourceId: string, signal: AbortSignal): Promise<ImageResource>
  /** 每次实际发送前生成无需额外鉴权的临时 HTTP(S) 地址。 */
  resolve(
    workspaceId: string,
    resourceId: string,
    signal: AbortSignal,
  ): Promise<{ url: string; expiresAt: number }>
}
export interface ArchivedMedia {
  id: string
  index: number
  type: MediaSegment['type']
  status: 'pending' | 'stored' | 'failed' | 'expired'
  /** 已完成的保存尝试次数，包含首次保存；旧失败记录缺省按 1 次处理。 */
  attempts?: number
  /** 最近一次保存失败的原因摘要，不含下载凭据。 */
  lastError?: string
  resource?: { resourceId: string; mimeType: string; filename: string; size: number }
}
export interface ArchivedMessage {
  id: string
  workspaceId: string
  connectionId: string
  platform: string
  sequence: number
  receivedAt: number
  message: IncomingMessage
  media: ArchivedMedia[]
}
export interface HistoryQuery {
  afterSequence?: number
  beforeSequence?: number
  startTime?: number
  endTime?: number
  senderId?: string
  keyword?: string
  limit?: number
}
/** 服务端归档扩展；连接负责平台下载，文件服务负责持久化和回收。 */
export interface MediaArchive {
  store(
    message: ArchivedMessage,
    media: ArchivedMedia,
    download: (
      limit: number,
      signal: AbortSignal,
    ) => Promise<{ data: Uint8Array; mimeType: string; filename: string }>,
    signal: AbortSignal,
  ): Promise<NonNullable<ArchivedMedia['resource']>>
  retain(workspaceId: string, policy: Readonly<ChatPolicy>): Promise<void>
  available(workspaceId: string, resourceId: string): Promise<boolean>
}
export interface IncomingMessage {
  id: string
  chat: ChatTarget
  sender: { id: string; name?: string; role?: 'owner' | 'admin' | 'member'; bot?: boolean }
  segments: readonly MessageSegment[]
  timestamp?: number
  chatName?: string
  /** 适配器验证引用的原消息确由本机器人发出后才设置。 */
  replyToBot?: boolean
  /** 仅保存平台消息本身，不包含连接凭据。 */
  raw?: unknown
  /** 仍归档，但不进入命令与 AI 处理（例如机器人自身或忽略的用户）。 */
  passive?: boolean
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
  /** 自动在系统提示词末尾追加 IM 回复格式；不影响显式模板变量。 */
  appendReplyFormat?: boolean
  agentId?: string
  activation?: ActivationPolicy
  userInputTemplate?: string
  historyLimit?: number
  maxImages?: number
  maxFiles?: number
  mediaRetentionDays?: number
  mediaMaxBytes?: number
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
  downloadMedia?(
    message: IncomingMessage,
    segment: MediaSegment,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; mimeType: string; filename: string }>
  /** 无发送副作用的消息格式检查，可用于批量投递前的完整预检。 */
  validateMessage?(segments: readonly MessageSegment[]): void
  /** 上传内部图片到平台；失败发生在认领消息投递之前，可安全重试。 */
  prepareImage?(image: ImageResource & { url: string }, signal: AbortSignal): Promise<MediaSegment>
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
    signal?: AbortSignal,
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
  readonly archived?: ArchivedMessage
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
