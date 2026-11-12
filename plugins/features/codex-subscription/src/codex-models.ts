import type { ModelDefinition } from '@antarestra/ai'
import { AuthError } from '@antarestra/rbac'
import { candidates, defaultModelLimits } from '@antarestra/ai-model-driver'
import type { ModelProviderConfig } from '@antarestra/ai-model-driver'
import type { CodexAccount } from './codex-types.js'
import { codexResource, oauthJson } from './codex-oauth.js'

export function codexProvider(account: CodexAccount): ModelProviderConfig & { name: string } {
  return {
    id: account.id,
    name: `ChatGPT 订阅 · ${account.id.slice(-8)}`,
    builtin: '',
    api: 'openai-responses',
    baseUrl: codexResource,
    headers: {},
    models: account.models,
  }
}
export async function codexModels(
  token: string,
  signal: AbortSignal,
  fetch = globalThis.fetch,
): Promise<ModelDefinition[]> {
  const body = await oauthJson(
    codexResource + '/models',
    signal,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    fetch,
  )
  if (!Array.isArray(body.models)) throw new AuthError(502, 'OpenAI 模型目录格式无效')
  const known = new Map(
    candidates({ builtin: 'openai', api: 'openai-responses' }).map((m) => [m.id, m]),
  )
  const result = new Map<string, ModelDefinition>()
  for (const value of body.models) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (
      item.visibility !== 'list' ||
      typeof item.slug !== 'string' ||
      !/^[\w.-]{1,200}$/.test(item.slug)
    )
      continue
    const builtin = known.get(item.slug)
    const contextWindow =
      typeof item.context_window === 'number' &&
      Number.isSafeInteger(item.context_window) &&
      item.context_window > 0
        ? item.context_window
        : (builtin?.contextWindow ?? defaultModelLimits.contextWindow)
    result.set(item.slug, {
      id: item.slug,
      title: typeof item.display_name === 'string' ? item.display_name.slice(0, 200) : item.slug,
      contextWindow,
      maxOutputTokens: Math.min(
        contextWindow,
        builtin?.maxOutputTokens ?? defaultModelLimits.maxOutputTokens,
      ),
      input: builtin?.input ?? ['text'],
      output: ['text'],
      tools: true,
      thinkingLevels: builtin?.thinkingLevels ?? [],
    })
    if (result.size > 10000) throw new AuthError(502, '模型目录超过数量限制')
  }
  return [...result.values()]
}

/** 官方订阅端点的请求限制，不修改普通 API 提供商的行为。 */
export function subscriptionPayload(payload: Record<string, unknown>) {
  for (const key of [
    'background',
    'conversation',
    'max_output_tokens',
    'max_tool_calls',
    'metadata',
    'moderation',
    'multi_agent',
    'prompt',
    'prompt_cache_retention',
    'prompt_cache_options',
    'safety_identifier',
    'temperature',
    'top_logprobs',
    'top_p',
    'truncation',
    'user',
    'previous_response_id',
  ])
    delete payload[key]
  payload.store = false
  payload.stream = true
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item: unknown) => {
      if (!item || typeof item !== 'object') return item
      const value = item as Record<string, unknown>
      if (value.role === 'system') return { ...value, role: 'developer' }
      if (value.type === 'function_call') return { ...value, namespace: 'antarestra' }
      return value
    })
  }
  if (Array.isArray(payload.tools)) {
    const tools = payload.tools as Record<string, unknown>[]
    const functions = tools.filter((tool) => tool.type === 'function' || tool.type === 'custom')
    payload.tools = [
      ...tools.filter((tool) => tool.type !== 'function' && tool.type !== 'custom'),
      ...(functions.length
        ? [
            {
              type: 'namespace',
              name: 'antarestra',
              description: 'Antarestra 工具',
              tools: functions,
            },
          ]
        : []),
    ]
  }
  return payload
}
