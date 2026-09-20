import type { Context } from '@antarestra/plugin-sdk'
import type {
  AgentPreset,
  AiEvent,
  ChatMessage,
  ContentBlock,
  Json,
  JsonObject,
  ModelDefinition,
  RequestSnapshot,
  RunRecord,
} from '@antarestra/contracts'
export type {
  AgentPreset,
  AiEvent,
  ChatMessage,
  ContentBlock,
  Json,
  JsonObject,
  ModelDefinition,
  RequestSnapshot,
  RunRecord,
} from '@antarestra/contracts'
export interface Config {
  maxModelCalls: number
  modelIdleTimeoutMs: number
  toolTimeoutMs: number
}
export interface RunContext {
  readonly runId: string
  readonly conversationId: string
  readonly workspaceId: string
  readonly actorId: string
  readonly agent: AgentPreset
  readonly signal: AbortSignal
}
export interface Tool {
  id: string
  description: string
  parameters: JsonObject
  timeoutMs?: number | null
  execute(arguments_: JsonObject, context: RunContext): Promise<Json>
}
export interface Provider {
  id: string
  title: string
  baseUrl: string
  driverId: string
  models: ModelDefinition[]
  idleTimeoutMs?: number
  resolveCredential?(context: RunContext): Promise<string>
}
export interface ModelOutput {
  content: ContentBlock[]
  usage?: JsonObject
}
export type ModelUpdate =
  { type: 'activity' } | { type: 'delta'; kind: 'text' | 'thinking'; text: string }
export interface ModelDriver {
  id: string
  parameters?: JsonObject
  estimateTokens?(request: RequestSnapshot): number | Promise<number>
  generate(
    request: RequestSnapshot,
    connection: { baseUrl: string; credential: string | undefined },
    context: RunContext,
    update: (event: ModelUpdate) => Promise<void>,
  ): Promise<ModelOutput>
}
export interface ExecutionRuntime {
  readonly context: RunContext
  readonly messages: readonly ChatMessage[]
  request(): Promise<ModelOutput>
  executeTools(calls: Extract<ContentBlock, { type: 'tool-call' }>[]): Promise<ChatMessage[]>
}
export interface ExecutionBackend {
  id: string
  run(runtime: ExecutionRuntime): Promise<void>
}
export interface SkillService {
  createTool(selection: string[] | null, context: RunContext): Promise<Tool>
}
/** 在读取目录或启动运行时解析，返回值会由核心复制并固定为运行快照。 */
export interface AgentDefinition {
  id: string
  isDefault?: boolean
  resolve(): AgentPreset | null
}
export interface Extension {
  id: string
  schema: JsonObject
  prepare?(context: RunContext, config: JsonObject): Promise<void>
}
export interface ResourceResolver {
  validate(
    resource: Extract<ContentBlock, { resourceId: string }>,
    context: RunContext,
  ): Promise<void>
}
export interface TemplateDraft {
  systemPrompt: string
  userPrompt: string
}
export interface ToolDraft {
  call: Extract<ContentBlock, { type: 'tool-call' }>
  blocked: string | null
  result: Json
  isError: boolean
}
declare module '@antarestra/plugin-sdk' {
  interface Events {
    'ai/prepare'(context: RunContext): void | Promise<void>
    'ai/template'(context: RunContext, draft: TemplateDraft): void | Promise<void>
    'ai/request'(context: RunContext, draft: RequestSnapshot): void | Promise<void>
    'ai/context'(context: RunContext, draft: RequestSnapshot): void | Promise<void>
    'ai/tool-before'(context: RunContext, draft: ToolDraft): void | Promise<void>
    'ai/tool-after'(context: RunContext, draft: ToolDraft): void | Promise<void>
    'ai/event'(event: Readonly<AiEvent>, agent: Readonly<AgentPreset>): void | Promise<void>
  }
}
export type Dispose = () => Promise<void>
export interface Registration<T> {
  owner: Context
  value: T
  active: boolean
  token: object
}
