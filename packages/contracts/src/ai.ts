export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export type ContentBlock =
  | {
      type: 'text' | 'thinking'
      text: string
      /** 驱动生成的不透明续接信息，仅能由相同连接、模型和驱动使用。 */
      continuation?: { model: ModelRef; driverId: string; signature: string }
    }
  | {
      type: 'image' | 'file'
      resourceId: string
      mimeType: string
      filename?: string
      url?: string
      size?: number
    }
  | { type: 'tool-call'; id: string; name: string; arguments: JsonObject }
  | { type: 'tool-result'; id: string; content: Json; isError: boolean }
  | { type: 'provider-tool'; id: string; name: string; status: string; result: JsonObject }
export interface ChatMessage {
  /** 服务端分配；旧记录通过运行 ID 与消息位置生成兼容标识。 */
  id?: string
  role: 'user' | 'assistant' | 'tool'
  content: ContentBlock[]
}
export interface ModelRef {
  providerId: string
  modelId: string
}
export interface ModelDefinition {
  id: string
  title: string
  contextWindow: number
  maxOutputTokens: number
  thinkingLevels: string[]
  input: ('text' | 'image' | 'file')[]
  output: ('text' | 'image' | 'file')[]
  tools: boolean
}
export interface AgentPreset {
  contextPolicy?: ContextPolicy
  id: string
  version: string
  title: string
  backendId: string
  systemTemplate: string
  userTemplate: string
  models: ModelRef[]
  defaultModel: ModelRef
  defaultThinking?: string
  toolIds: string[]
  skillIds: string[] | null
  extensions: Record<string, JsonObject>
}
export interface UserInput {
  text: string
  variables?: JsonObject
  attachments?: Extract<ContentBlock, { resourceId: string }>[]
}
export interface ConversationTodo {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}
export interface Conversation {
  id: string
  workspaceId: string
  actorId: string
  agentId: string
  title: string
  todos?: ConversationTodo[]
  selectedNodeId: string | null
  revision: number
  activeRunId: string | null
  createdAt: number
  lastActivityAt: number
  archivedAt: number | null
}
/** 序号仅在本次连接内递增；ready 要求客户端重新读取列表快照。 */
export type ConversationStateEvent =
  | { sequence: number; type: 'ready' }
  | { sequence: number; type: 'conversation'; conversation: Conversation }
  | { sequence: number; type: 'deleted'; conversationId: string; workspaceId: string }

export interface MessageNode {
  id: string
  conversationId: string
  parentId: string | null
  runId: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
  input?: UserInput
  createdAt: number
  version: number
  versionCount: number
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface RequestSnapshot {
  purpose?: 'reply' | 'compaction'
  maxOutputTokens?: number
  model: ModelRef
  thinking: string | null
  parameters: JsonObject
  systemPrompt: string
  messages: ChatMessage[]
  tools: {
    id: string
    description: string
    parameters: JsonObject
    providerTool?: { name: string; type: string; options: JsonObject }
  }[]
}
export interface RunRecord {
  contextBudgets?: ContextBudget[]
  contextOperations?: ContextOperation[]
  id: string
  conversationId: string
  workspaceId: string
  actorId: string
  userNodeId: string
  replyNodeId: string
  status: RunStatus
  agent: AgentPreset
  model: ModelRef
  thinking: string | null
  input: UserInput
  messages: ChatMessage[]
  requests: RequestSnapshot[]
  error: { code: string; message: string } | null
  createdAt: number
  endedAt: number | null
}
export interface RunCommand {
  operation: 'send' | 'edit' | 'regenerate'
  expectedRevision: number
  expectedNodeId: string | null
  idempotencyKey: string
  targetNodeId?: string
  input?: UserInput
  model?: ModelRef
  thinking?: string | null
}
export interface AiEvent {
  runId: string
  conversationId: string
  workspaceId: string
  sequence: number
  type:
    | 'run-start'
    | 'request'
    | 'model-activity'
    | 'provider-tool'
    | 'message-delta'
    | 'message'
    | 'tool-start'
    | 'tool-end'
    | 'run-end'
    | 'context-budget'
    | 'context-operation'
  data: Json
  createdAt: number
}

export type TokenAmount = number | string
export interface ContextPolicy {
  compaction: {
    enabled: boolean
    reserve: TokenAmount
    keepRecent: TokenAmount
    model: ModelRef | null
    thinking: string | null
  }
  trimming: { enabled: boolean; mode: 'auto' | 'rounds'; rounds: number; keepFirst: boolean }
}
export interface ContextBudget {
  model: ModelRef
  window: number
  used: number
  remaining: number
  reserve: number
  available: number
  phase: 'before' | 'prepared' | 'after'
  source: 'estimate' | 'usage'
  createdAt: number
}
export interface ContextOperation {
  id: string
  kind: 'trim' | 'compact'
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  /** 插入到本次运行的第几个助理内容块之前。 */
  position: number
  before: number
  after?: number
  createdAt: number
  endedAt: number | null
  error?: string
}
export interface ContextSummary {
  id: string
  workspaceId: string
  conversationId: string
  runId: string
  parentNodeId: string | null
  /** 覆盖的原始消息 ID 及内容指纹，顺序也参与有效性检查。 */
  sources: { id: string; hash: string }[]
  firstKeptId: string | null
  previousSummaryIds: string[]
  text: string
  model: ModelRef
  thinking: string | null
  usage: JsonObject[]
  createdAt: number
}
