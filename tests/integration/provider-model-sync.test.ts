import { expect, it } from 'vitest'
import type { ModelDefinition } from '@antarestra/ai'
import type { Candidate } from '../../plugins/features/ai-provider/src/types.js'
import {
  modelSyncRows,
  planModelSync,
  syncModels,
} from '../../plugins/features/ai-provider/client/models.js'

const model = (id: string): ModelDefinition => ({
  id,
  title: id,
  contextWindow: 8192,
  maxOutputTokens: 1024,
  input: ['text'],
  output: ['text'],
  tools: true,
  thinkingLevels: [],
})
const candidate = (id: string, source: Candidate['source'] = 'builtin'): Candidate => ({
  ...model(id),
  contextWindow: 128000,
  source,
})

it('未获取 API 或获取失败时仅按内置目录判断待删除，空目录仍可删除已有模型', () => {
  const current = [model('builtin'), model('retired')]
  const rows = modelSyncRows(current, [candidate('builtin'), candidate('new')], false)
  expect(rows.map((row) => [row.model.id, row.status])).toEqual([
    ['builtin', 'update'],
    ['new', 'add'],
    ['retired', 'delete'],
  ])
  const empty = planModelSync(modelSyncRows(current, [], false), 'all')
  expect(empty.deletions).toEqual(['builtin', 'retired'])
  expect(syncModels(current, empty.updates, empty.deletions)).toEqual([])
})

it('API 缺失的内置已有模型仅推荐删除，同步全部保留并覆盖，统计不受勾选影响', () => {
  const current = [model('both'), model('builtin'), model('remote'), model('retired')]
  const rows = modelSyncRows(
    current,
    [
      candidate('both', 'both'),
      candidate('builtin'),
      candidate('remote', 'remote'),
      candidate('new'),
    ],
    true,
  )
  expect(rows.map((row) => row.status)).toEqual([
    'update',
    'recommend-delete',
    'update',
    'add',
    'delete',
  ])
  const plan = planModelSync(rows, 'all', ['builtin'])
  expect(plan).toMatchObject({ added: 1, modified: 3, deletions: ['retired'] })
  const synced = syncModels(current, plan.updates, plan.deletions)
  expect(synced.map((item) => item.id)).toEqual(['both', 'builtin', 'remote', 'new'])
  expect(synced.find((item) => item.id === 'builtin')?.contextWindow).toBe(128000)
  expect(synced.every((item) => !Object.hasOwn(item, 'source'))).toBe(true)
  expect(planModelSync(modelSyncRows(synced, plan.updates, true), 'all')).toMatchObject({
    added: 0,
    modified: 4,
    deletions: [],
  })
})

it('混合勾选时覆盖按钮只增改，删除按钮只删除勾选的待删除和推荐删除项', () => {
  const current = [model('active'), model('recommended'), model('retired'), model('unselected')]
  const rows = modelSyncRows(
    current,
    [candidate('active', 'remote'), candidate('recommended'), candidate('new')],
    true,
  )
  const selection = ['active', 'recommended', 'retired', 'new', 'unknown']
  const update = planModelSync(rows, 'update', selection)
  expect(update).toMatchObject({ added: 1, modified: 2, deletions: [] })
  expect(syncModels(current, update.updates)).toContainEqual(model('retired'))
  const remove = planModelSync(rows, 'delete', selection)
  expect(remove).toEqual({
    updates: [],
    added: 0,
    modified: 0,
    deletions: ['recommended', 'retired'],
  })
  expect(syncModels(current, remove.updates, remove.deletions)).toEqual([
    model('active'),
    model('unselected'),
  ])
  expect(planModelSync(rows, 'delete')).toMatchObject({ updates: [], deletions: [] })
})

it('API 返回空目录时内置已有模型仅推荐删除，重复候选按 ID 去重', () => {
  const rows = modelSyncRows(
    [model('builtin'), model('retired')],
    [candidate('builtin'), candidate('builtin')],
    true,
  )
  expect(rows).toHaveLength(2)
  expect(planModelSync(rows, 'all')).toMatchObject({
    added: 0,
    modified: 1,
    deletions: ['retired'],
  })
})
