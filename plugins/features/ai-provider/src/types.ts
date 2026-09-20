import type { ModelDefinition } from '@antarestra/ai'

export interface ProviderRecord {
  id: string
  name: string
  note: string
  builtin: string
  api: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  models: ModelDefinition[]
  revision: number
}
export type ProviderView = Omit<ProviderRecord, 'apiKey'> & { apiKeyPlaceholder: string }
export interface Candidate extends ModelDefinition {
  source: 'builtin' | 'remote' | 'both'
}
export interface Discovery {
  models: Candidate[]
  warning: string
}
export const defaultModelLimits = { contextWindow: 128000, maxOutputTokens: 65535 }
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
