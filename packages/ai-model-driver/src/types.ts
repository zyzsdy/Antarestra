import type { ModelDefinition, ResolvedResource } from '@antarestra/ai'

/** 驱动只接收模型与连接配置，不持有账户凭据或持久化记录。 */
export interface ModelProviderConfig {
  id: string
  builtin: string
  api: string
  baseUrl: string
  headers: Record<string, string>
  models: ModelDefinition[]
}
export interface Candidate extends ModelDefinition {
  source: 'builtin' | 'remote' | 'both'
}
export const defaultModelLimits = { contextWindow: 128000, maxOutputTokens: 65535 }

export interface ToolLease {
  blocked: string[]
  message: string
  finish(counts: Map<string, number>, completed: boolean): Promise<void>
}
/** 策略由调用插件提供；共享包不依赖账户、数据库或订阅协议。 */
export interface DriverOptions {
  id: string
  fetch?: typeof globalThis.fetch
  /** 为不支持自定义 Fetch 的 SDK 提供实例独立的传输地址。 */
  requestBaseUrl?(api: string, baseUrl: string): Promise<string>
  reserveTools?(workspaceId: string, names: string[]): Promise<ToolLease>
  validateFiles?(files: ReadonlyMap<string, ResolvedResource>): void
  transformPayload?(payload: Record<string, unknown>): Record<string, unknown>
  completionEvent?: { type: string; missingMessage: string }
}
