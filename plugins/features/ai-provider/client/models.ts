import type { ModelDefinition } from '@antarestra/ai'
import type { Candidate } from '../src/types.js'

export interface SyncRow {
  model: ModelDefinition
  candidate?: Candidate
  status: 'add' | 'update' | 'delete' | 'recommend-delete'
}

export function modelSyncRows(
  current: ModelDefinition[],
  candidates: Candidate[],
  remoteFetched: boolean,
): SyncRow[] {
  const existing = new Set(current.map((model) => model.id))
  const available = new Map(candidates.map((model) => [model.id, model]))
  return [
    ...[...available.values()].map((candidate): SyncRow => ({
      model: candidate,
      candidate,
      status: !existing.has(candidate.id)
        ? 'add'
        : remoteFetched && candidate.source === 'builtin'
          ? 'recommend-delete'
          : 'update',
    })),
    ...current
      .filter((model) => !available.has(model.id))
      .map((model): SyncRow => ({ model, status: 'delete' })),
  ]
}

export function planModelSync(
  rows: SyncRow[],
  mode: 'all' | 'update' | 'delete',
  selection: string[] = [],
) {
  const selected = new Set(selection)
  const updates: Candidate[] = []
  const deletions: string[] = []
  let added = 0
  for (const row of rows) {
    if (mode !== 'all' && !selected.has(row.model.id)) continue
    if (
      (mode === 'all' && row.status === 'delete') ||
      (mode === 'delete' && ['delete', 'recommend-delete'].includes(row.status))
    ) {
      deletions.push(row.model.id)
    } else if (mode !== 'delete' && row.candidate) {
      updates.push(row.candidate)
      if (row.status === 'add') added++
    }
  }
  return { updates, deletions, added, modified: updates.length - added }
}

export function syncModels(
  current: ModelDefinition[],
  selected: Candidate[],
  deleted: string[] = [],
): ModelDefinition[] {
  const models = new Map(current.map((model) => [model.id, model]))
  for (const { source: _source, ...model } of selected) models.set(model.id, model)
  for (const id of deleted) models.delete(id)
  return [...models.values()]
}
