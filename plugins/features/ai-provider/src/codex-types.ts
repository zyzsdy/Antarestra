import type { ModelDefinition } from '@antarestra/ai'

export interface CodexAccountView {
  id: string
  email: string
  clientId: string
  connected: boolean
  expiresAt: number | null
  models: ModelDefinition[]
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
export interface CodexAccount extends Omit<CodexAccountView, 'connected' | 'expiresAt'> {
  ownerId: string
  subject: string
  tokens?: CodexTokens
}
export interface CodexState {
  version: 1
  hostId: string
  accounts: CodexAccount[]
}
