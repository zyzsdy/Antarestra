import type { ModelDefinition } from '@antarestra/ai'

export interface CodexWebSearch {
  enabled: boolean
  modelIds: string[]
  revision: number
}

export interface CodexAccountView {
  id: string
  email: string
  clientId: string
  connected: boolean
  expiresAt: number | null
  models: ModelDefinition[]
  webSearch: CodexWebSearch
}
export interface CodexLoginView {
  id: string
  url: string
  redirectUri: string
  expiresAt: number
  status: 'pending' | 'exchanging' | 'completed' | 'failed'
  error: string
}
export interface CodexTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  scopes: string[]
}
export interface CodexAccount extends Omit<
  CodexAccountView,
  'connected' | 'expiresAt' | 'webSearch'
> {
  ownerId: string
  subject: string
  tokens?: CodexTokens
  /** 旧凭据文件缺省时保持关闭，不自动扩大模型范围。 */
  webSearch?: CodexWebSearch
}
export interface CodexState {
  version: 1
  hostId: string
  accounts: CodexAccount[]
}
