import { defineMigration } from '@antarestra/database'

export const pluginId = '@antarestra/plugin-wake-tasks'
export interface TaskRow {
  id: string
  workspace_id: string
  actor_id: string
  source: string
  source_provider: string
  source_conversation_id: string
  agent_id: string
  reason: string
  prompt: string
  interval_ms: number | null
  trigger_at: number
  next_at: number
  available_at: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  lease_token: string
  conversation_id: string
  last_conversation_id: string | null
  last_run_id: string | null
  last_error: string | null
  attempts: number
  created_at: number
}
export interface Tables {
  tasks: TaskRow
}
export const migrations = [
  defineMigration({
    id: '001_wake_tasks',
    steps: [
      {
        kind: 'createTable',
        table: 'tasks',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          ...[
            'workspace_id',
            'actor_id',
            'source',
            'source_provider',
            'source_conversation_id',
            'agent_id',
            'lease_token',
            'conversation_id',
          ].map((name) => ({ name, type: 'string' as const, length: 200, notNull: true })),
          { name: 'status', type: 'string', length: 20, notNull: true },
          { name: 'reason', type: 'text', notNull: true },
          { name: 'prompt', type: 'text', notNull: true },
          { name: 'interval_ms', type: 'timestamp' },
          ...['trigger_at', 'next_at', 'available_at', 'created_at'].map((name) => ({
            name,
            type: 'timestamp' as const,
            notNull: true,
          })),
          { name: 'attempts', type: 'integer', notNull: true },
          { name: 'last_conversation_id', type: 'string', length: 200 },
          { name: 'last_run_id', type: 'string', length: 200 },
          { name: 'last_error', type: 'text' },
        ],
      },
      {
        kind: 'createIndex',
        table: 'tasks',
        name: 'due_tasks',
        columns: ['status', 'available_at', 'id'],
      },
      {
        kind: 'createIndex',
        table: 'tasks',
        name: 'workspace_tasks',
        columns: ['workspace_id', 'id'],
      },
    ],
  }),
]
