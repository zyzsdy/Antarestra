export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export type ContentBlock =
  | {
      type: 'text' | 'thinking'
      text: string
      /** 驱动生成的不透明续接信息，仅能由相同连接、模型和驱动使用。 */
      continuation?: { model: ModelRef; driverId: string; signature: string }
    }
  | { type: 'image' | 'file'; resourceId: string; mimeType: string }
  | { type: 'tool-call'; id: string; name: string; arguments: JsonObject }
  | { type: 'tool-result'; id: string; content: Json; isError: boolean }
export interface ChatMessage {
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
export interface Conversation {
  id: string
  workspaceId: string
  actorId: string
  agentId: string
  title: string
  selectedNodeId: string | null
  revision: number
  activeRunId: string | null
  createdAt: number
  lastActivityAt: number
  archivedAt: number | null
}
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
  model: ModelRef
  thinking: string | null
  parameters: JsonObject
  systemPrompt: string
  messages: ChatMessage[]
  tools: { id: string; description: string; parameters: JsonObject }[]
}
export interface RunRecord {
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
    | 'message-delta'
    | 'message'
    | 'tool-start'
    | 'tool-end'
    | 'run-end'
  data: Json
  createdAt: number
}
