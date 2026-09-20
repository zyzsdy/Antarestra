import type { ModelDefinition } from '@antarestra/ai'
import type { Candidate } from '../src/types.js'

export function syncModels(current: ModelDefinition[], selected: Candidate[]): ModelDefinition[] {
  const models = new Map(current.map((model) => [model.id, model]))
  for (const { source: _source, ...model } of selected) models.set(model.id, model)
  return [...models.values()]
}
