import { defineMigration } from '@antarestra/database'

export interface Tables {
  records: {
    id: string
    workspace_id: string
    title: string
    enabled: number
    created_at: number
    payload: string
    score: number
  }
  labels: { id: string; record_id: string; title: string }
}

export const initial = defineMigration({
  id: '001_init',
  steps: [
    {
      kind: 'createTable',
      table: 'records',
      columns: [
        { name: 'id', type: 'string', length: 64, primaryKey: true },
        { name: 'workspace_id', type: 'string', length: 64, notNull: true },
        { name: 'title', type: 'string', length: 100, notNull: true },
        { name: 'enabled', type: 'boolean', notNull: true, default: 1 },
        { name: 'created_at', type: 'timestamp', notNull: true },
        { name: 'payload', type: 'json', notNull: true, default: '{}' },
        { name: 'score', type: 'float', notNull: true, default: 0 },
      ],
    },
    {
      kind: 'createTable',
      table: 'labels',
      columns: [
        { name: 'id', type: 'string', length: 64, primaryKey: true },
        { name: 'record_id', type: 'string', length: 64, notNull: true },
        { name: 'title', type: 'text', notNull: true },
      ],
    },
    {
      kind: 'createIndex',
      table: 'records',
      name: 'records_workspace_title',
      columns: ['workspace_id', 'title'],
      unique: true,
    },
  ],
})

export const upgrade = defineMigration({
  id: '002_upgrade',
  steps: [
    { kind: 'addColumn', table: 'records', column: { name: 'note', type: 'integer' } },
    { kind: 'renameColumn', table: 'records', from: 'note', to: 'remark' },
    { kind: 'dropColumn', table: 'records', column: 'remark' },
    { kind: 'createIndex', table: 'labels', name: 'labels_title', columns: ['record_id'] },
    { kind: 'dropIndex', table: 'labels', name: 'labels_title' },
    { kind: 'createTable', table: 'temporary', columns: [{ name: 'value', type: 'text' }] },
    { kind: 'dropTable', table: 'temporary' },
  ],
})

// 供独立进程中断测试使用；首表可见后仍有足够多的 DDL，确保可在提交历史前终止。
export const interrupted = defineMigration({
  id: '001_interrupted',
  steps: Array.from({ length: 512 }, (_, index) => ({
    kind: 'createTable' as const,
    table: `part_${index}`,
    columns: [{ name: 'value', type: 'text' as const }],
  })),
})
