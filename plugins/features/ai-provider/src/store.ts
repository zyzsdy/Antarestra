import { defineMigration } from '@antarestra/database'
export const name = '@antarestra/plugin-ai-provider'
export interface Tables {
  providers: { id: string; payload: string }
  builtin_usage: {
    id: string
    workspace_id: string
    provider_id: string
    tool_type: string
    created_at: string
    calls: number
  }
}
export const migrations = [
  defineMigration({
    id: '001_providers',
    steps: [
      {
        kind: 'createTable',
        table: 'providers',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'payload', type: 'text', notNull: true },
        ],
      },
    ],
  }),
  defineMigration({
    id: '002_builtin_usage',
    steps: [
      {
        kind: 'createTable',
        table: 'builtin_usage',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'workspace_id', type: 'string', length: 200, notNull: true },
          { name: 'provider_id', type: 'string', length: 200, notNull: true },
          { name: 'tool_type', type: 'string', length: 100, notNull: true },
          { name: 'created_at', type: 'string', length: 30, notNull: true },
          { name: 'calls', type: 'integer', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'builtin_usage',
        name: 'usage_scope',
        columns: ['workspace_id', 'provider_id'],
      },
      {
        kind: 'createIndex',
        table: 'builtin_usage',
        name: 'usage_expiry',
        columns: ['created_at'],
      },
    ],
  }),
]
