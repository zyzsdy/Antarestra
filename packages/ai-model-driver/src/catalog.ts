import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { Candidate, ModelProviderConfig } from './types.js'

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
export function candidates(provider: Pick<ModelProviderConfig, 'builtin' | 'api'>): Candidate[] {
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
export function builtinParameters(
  provider: Pick<ModelProviderConfig, 'builtin' | 'api'>,
): Map<string, Candidate> {
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
