export interface RequestContext {
  actorId: string
  workspaceId: string
  conversationId: string
  channelInstanceId: string
}

export interface AgentPreset {
  id: string
  name: string
  systemPrompt: string
  backendId: string
  connectionId: string
  modelId: string
  toolIds: readonly string[]
  skillIds: readonly string[]
  mcpServerIds: readonly string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// 初始化阶段的最小事件协议，后续按需求增加工具和用量事件。
export type AgentEvent =
  { type: 'text-delta'; text: string } | { type: 'completed' } | { type: 'cancelled' }
