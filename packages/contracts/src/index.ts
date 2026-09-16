export interface RequestContext {
  actorId: string
  workspaceId: string
  conversationId: string
  channelInstanceId: string
}

/** 仅供客户端展示与路由判断，不包含凭据，不可用作服务端授权证明。 */
export interface SessionSnapshot {
  actorId: string
  displayName: string
  accountPath: string
  expiresAt: number
  /** 仅包含当前账号有效的系统范围权限；不可推断工作空间授权。 */
  permissions: string[]
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
