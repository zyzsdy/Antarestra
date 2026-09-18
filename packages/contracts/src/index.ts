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
  /** 本地认证要求先修改初始密码时为 true；仅用于客户端导航提示。 */
  passwordChangeRequired?: boolean
}

export * from './ai.js'
