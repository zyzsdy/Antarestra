import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Candidate, Discovery, ProviderRecord } from './types.js'
import { defaultModelLimits } from './types.js'

export function builtinModels(id: string): Model<Api>[] {
  const builtin = getBuiltinProviders().find((provider) => provider === id)
  return builtin ? getBuiltinModels(builtin) : []
}
export function catalog() {
  return getBuiltinProviders().map((id) => {
    const model = builtinModels(id)[0]
    return { id, name: id, api: model?.api ?? 'openai-completions', baseUrl: model?.baseUrl ?? '' }
  })
}
export function candidates(provider: ProviderRecord): Candidate[] {
  const models = new Map<string, Candidate>()
  const builtin = builtinModels(provider.builtin)
  for (const model of [...builtin.filter((model) => model.api === provider.api), ...builtin]) {
    if (!models.has(model.id)) models.set(model.id, candidate(model))
  }
  return [...models.values()]
}
function candidate(model: Model<Api>): Candidate {
  return {
    id: model.id,
    title: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: Math.min(model.maxTokens, model.contextWindow),
    thinkingLevels: model.reasoning
      ? getSupportedThinkingLevels(model).filter((level) => level !== 'off')
      : [],
    input: [...model.input],
    output: ['text'],
    tools: true,
    source: 'builtin',
  }
}
function builtinParameters(provider: ProviderRecord): Map<string, Candidate> {
  const selected = builtinModels(provider.builtin)
  const all = getBuiltinProviders().flatMap((id) => builtinModels(id))
  const models = new Map<string, Candidate>()
  // 完整 ID 匹配；所选提供商优先，其次相同接口，最后跨接口补全模型能力。
  for (const model of [
    ...selected.filter((model) => model.api === provider.api),
    ...selected,
    ...all.filter((model) => model.api === provider.api),
    ...all,
  ]) {
    if (!models.has(model.id)) models.set(model.id, candidate(model))
  }
  return models
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const positive = (value: unknown, fallback: number) =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback

export async function discover(provider: ProviderRecord, signal: AbortSignal): Promise<Discovery> {
  const merged = new Map(candidates(provider).map((model) => [model.id, model]))
  const supported = [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
    'mistral-conversations',
  ]
  if (!supported.includes(provider.api))
    return {
      models: [...merged.values()],
      warning: '此接口格式暂不支持远端模型枚举，可同步内置模型或手动添加。',
    }
  const base = provider.baseUrl.replace(/\/$/, '')
  const url = new URL(
    base +
      (provider.api === 'anthropic-messages' && !base.endsWith('/v1') ? '/v1/models' : '/models'),
  )
  const headers: Record<string, string> = { accept: 'application/json' }
  if (provider.api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
  } else if (provider.api === 'google-generative-ai') {
    if (provider.apiKey) headers['x-goog-api-key'] = provider.apiKey
  } else if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`
  Object.assign(headers, provider.headers)
  const remote: Candidate[] = []
  try {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const cursors = new Set<string>()
    for (let page = 0; page < 30; page++) {
      const response = await fetch(url, { headers, signal: combined, redirect: 'error' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      // 限制目录响应，避免将网关返回的任意大内容载入内存。
      const reader = response.body?.getReader()
      if (!reader) throw new Error('空响应')
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > 4_194_304) throw new Error('模型目录过大')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const items = body.data ?? body.models
      if (!Array.isArray(items)) throw new Error('模型目录格式无效')
      for (const item of items) {
        const value = record(item)
        const rawId = value.id ?? value.name
        if (typeof rawId !== 'string') continue
        const id = provider.api === 'google-generative-ai' ? rawId.replace(/^models\//, '') : rawId
        if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id)) continue
        const contextWindow = positive(
          value.context_length ?? value.contextWindow ?? value.inputTokenLimit,
          defaultModelLimits.contextWindow,
        )
        remote.push({
          id,
          title:
            typeof (value.displayName ?? value.display_name ?? value.name) === 'string'
              ? String(value.displayName ?? value.display_name ?? value.name).slice(0, 200)
              : id,
          contextWindow,
          maxOutputTokens: Math.min(
            contextWindow,
            positive(
              value.outputTokenLimit ?? value.max_output_tokens,
              defaultModelLimits.maxOutputTokens,
            ),
          ),
          input: ['text'],
          output: ['text'],
          tools: true,
          thinkingLevels: [],
          source: 'remote',
        })
        if (remote.length > 10000) throw new Error('模型数量超过限制')
      }
      const next = body.nextPageToken ?? (body.has_more ? body.last_id : undefined)
      if (!next) break
      if (typeof next !== 'string' || cursors.has(next) || page === 29)
        throw new Error('模型分页未完成')
      cursors.add(next)
      url.searchParams.set(provider.api === 'google-generative-ai' ? 'pageToken' : 'after_id', next)
    }
    const parameters = builtinParameters(provider)
    for (const model of remote) {
      const builtin = parameters.get(model.id)
      merged.set(model.id, builtin ? { ...builtin, source: 'both' } : model)
    }
    return { models: [...merged.values()], warning: '' }
  } catch {
    return {
      models: [...merged.values()],
      warning: '获取远端模型失败，请检查接口格式、Base URL、API Key 和网络；当前仅展示内置目录。',
    }
  }
}
