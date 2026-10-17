import { applicationUserAgent } from '@antarestra/plugin-sdk'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getPiUserAgent } from '@earendil-works/pi-ai/utils/pi-user-agent'

const piUserAgentApis = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
])

function hasUserAgent(headers: Record<string, string | null> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'user-agent')
}

/** 仅扩展 pi 的默认标识，保留提供商、模型和特殊认证流程的 User-Agent。 */
export function providerRequestHeaders(
  model: Model<Api>,
  credential: string | undefined,
  headers: Record<string, string | null>,
): Record<string, string | null> {
  const claudeOAuth =
    model.api === 'anthropic-messages' &&
    model.provider !== 'github-copilot' &&
    credential?.includes('sk-ant-oat')
  const entries = Object.entries(headers)
  const customUserAgent = entries.filter(([name]) => name.toLowerCase() === 'user-agent').at(-1)
  // 对齐 SDK 默认头的键名，避免大小写不同导致默认值回盖或两个 UA 被拼接。
  if (customUserAgent)
    return {
      ...Object.fromEntries(entries.filter(([name]) => name.toLowerCase() !== 'user-agent')),
      [claudeOAuth || model.api === 'bedrock-converse-stream' ? 'user-agent' : 'User-Agent']:
        customUserAgent[1],
    }
  if (claudeOAuth || !piUserAgentApis.has(model.api) || hasUserAgent(model.headers))
    return { ...headers }
  return { 'User-Agent': `${getPiUserAgent()} ${applicationUserAgent()}`, ...headers }
}
