import type { ModelProviderConfig, Candidate } from '@antarestra/ai-model-driver/types'
export type { Candidate } from '@antarestra/ai-model-driver/types'
export { defaultModelLimits } from '@antarestra/ai-model-driver/types'
import type { JsonObject } from '@antarestra/ai'

export interface BuiltinTool {
  name: string
  type: string
  modelIds: string[]
  options: JsonObject
  enabled: boolean
  callsPer5Hours?: number
}

export interface ProviderRecord extends ModelProviderConfig {
  proxy?: string
  name: string
  note: string
  apiKey: string
  builtinTools?: BuiltinTool[]
  revision: number
}
export type ProviderView = Omit<ProviderRecord, 'apiKey'> & { apiKeyPlaceholder: string }
export interface Discovery {
  models: Candidate[]
  warning: string
}
export const apiFormats = [
  { id: 'openai-completions', name: 'OpenAI Chat Completions' },
  { id: 'openai-responses', name: 'OpenAI Responses' },
  { id: 'anthropic-messages', name: 'Anthropic Messages' },
  { id: 'google-generative-ai', name: 'Google Generative AI' },
  { id: 'mistral-conversations', name: 'Mistral Conversations' },
  { id: 'azure-openai-responses', name: 'Azure OpenAI Responses' },
  { id: 'openai-codex-responses', name: 'OpenAI Codex Responses' },
  { id: 'bedrock-converse-stream', name: 'Amazon Bedrock' },
  { id: 'google-vertex', name: 'Google Vertex AI' },
  { id: 'pi-messages', name: 'Pi Messages' },
]
export const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
