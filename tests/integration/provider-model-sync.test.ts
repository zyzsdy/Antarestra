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
      candidate('new', 'remote'),
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
    [candidate('builtin'), candidate('builtin'), candidate('new')],
    true,
  )
  expect(rows).toHaveLength(3)
  expect(planModelSync(rows, 'all')).toMatchObject({
    added: 0,
    modified: 1,
    deletions: ['retired'],
  })
})

it('本地八个、内置十个时，获取 API 返回相同八个后同步全部由新增两个变为零个', () => {
  const current = Array.from({ length: 8 }, (_, index) => model(`model-${index}`))
  const builtins = Array.from({ length: 10 }, (_, index) => candidate(`model-${index}`))
  expect(planModelSync(modelSyncRows(current, builtins, false), 'all')).toMatchObject({
    added: 2,
    modified: 8,
    deletions: [],
  })

  const discovered = builtins.map((item, index) =>
    candidate(item.id, index < 8 ? 'both' : 'builtin'),
  )
  const rows = modelSyncRows(current, discovered, true)
  const plan = planModelSync(rows, 'all', ['model-8', 'model-9'])
  expect(plan).toMatchObject({ added: 0, modified: 8, deletions: [] })
  const synced = syncModels(current, plan.updates, plan.deletions)
  expect(synced.map((item) => item.id)).toEqual(current.map((item) => item.id))
  expect(synced.every((item) => item.contextWindow === 128000)).toBe(true)

  const manual = planModelSync(rows, 'update', ['model-8', 'model-9'])
  expect(manual).toMatchObject({ added: 2, modified: 0, deletions: [] })
  expect(syncModels(current, manual.updates)).toHaveLength(10)
})

it('获取 API 后同步全部新增 API 独有和双方共有模型，跳过仅内置的新模型', () => {
  const candidates = [
    candidate('builtin'),
    candidate('both', 'both'),
    candidate('remote', 'remote'),
  ]
  const plan = planModelSync(modelSyncRows([], candidates, true), 'all')
  expect(plan).toMatchObject({ added: 2, modified: 0, deletions: [] })
  expect(syncModels([], plan.updates).map((item) => item.id)).toEqual(['both', 'remote'])
  expect(planModelSync(modelSyncRows([], [candidate('builtin')], true), 'all')).toEqual({
    updates: [],
    deletions: [],
    added: 0,
    modified: 0,
  })
})
