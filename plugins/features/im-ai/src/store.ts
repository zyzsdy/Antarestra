import { defineMigration } from '@antarestra/database'

export const pluginId = '@antarestra/plugin-im-ai'
export interface SessionRow {
  workspace_id: string
  conversation_id: string
  agent_id: string
}
export interface JobRow {
  id: string
  workspace_id: string
  actor_id: string
  connection_id: string
  chat_type: 'private' | 'group'
  chat_id: string
  input: string
  snapshot: string | null
  conversation_id: string | null
  command: string | null
  run_id: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  answer: string | null
  reply_plan: string | null
  delivery: 'pending' | 'sent' | 'failed' | 'unknown'
  attempts: number
  created_at: number
}
export interface Tables {
  cursors: { workspace_id: string; sequence: number }
  sessions: SessionRow
  jobs: JobRow
}
export const migrations = [
  defineMigration({
    id: '001_im_ai',
    steps: [
      {
        kind: 'createTable',
        table: 'sessions',
        columns: [
          { name: 'workspace_id', type: 'string', length: 200, primaryKey: true },
          ...['conversation_id', 'agent_id'].map((name) => ({
            name,
            type: 'string' as const,
            length: 200,
            notNull: true,
          })),
        ],
      },
      {
        kind: 'createTable',
        table: 'jobs',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          ...[
            'workspace_id',
            'actor_id',
            'connection_id',
            'chat_id',
            'chat_type',
            'status',
            'delivery',
          ].map((name) => ({ name, type: 'string' as const, length: 200, notNull: true })),
          ...['conversation_id', 'run_id'].map((name) => ({
            name,
            type: 'string' as const,
            length: 200,
          })),
          { name: 'input', type: 'text', notNull: true },
          { name: 'command', type: 'text' },
          { name: 'answer', type: 'text' },
          { name: 'attempts', type: 'integer', notNull: true },
          { name: 'created_at', type: 'timestamp', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'jobs',
        name: 'pending_jobs',
        columns: ['delivery', 'created_at'],
      },
      {
        kind: 'createIndex',
        table: 'jobs',
        name: 'workspace_jobs',
        columns: ['workspace_id', 'status'],
      },
    ],
  }),
  defineMigration({
    id: '002_input_snapshot',
    steps: [
      { kind: 'addColumn', table: 'jobs', column: { name: 'snapshot', type: 'text' } },
      {
        kind: 'createTable',
        table: 'cursors',
        columns: [
          { name: 'workspace_id', type: 'string', length: 200, primaryKey: true },
          { name: 'sequence', type: 'integer', notNull: true },
        ],
      },
    ],
  }),
  defineMigration({
    id: '003_reply_plan',
    steps: [{ kind: 'addColumn', table: 'jobs', column: { name: 'reply_plan', type: 'text' } }],
  }),
]
