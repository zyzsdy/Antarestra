export type TransportKind = 'local' | 'streamable-http' | 'sse'
export interface ServerRecord {
  id: string
  revision: number
  order: number
  name: string
  description: string
  activationDescription: string
  enabled: boolean
  transport: TransportKind
  url: string
  command: string
  args: string[]
  cwd: string
  headers: Record<string, string>
  env: Record<string, string>
  prefixEnabled: boolean
  prefix: string
}
export interface ServerView extends Omit<ServerRecord, 'headers' | 'env'> {
  headers: Record<string, null>
  env: Record<string, null>
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  error: string
  tools: { name: string; id: string; description: string }[]
}
export interface ServerInput extends Omit<ServerRecord, 'id' | 'order' | 'headers' | 'env'> {
  headers: Record<string, string | null>
  env: Record<string, string | null>
}
