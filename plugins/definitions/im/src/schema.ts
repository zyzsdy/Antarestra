import { defineMigration } from '@antarestra/database'
export const pluginId = '@antarestra/im'
export interface Tables {
  history: {
    id: string
    workspace_id: string
    connection_id: string
    connection_key: string
    sequence: number
    timestamp: number
    sender_id: string
    text: string
    payload: string
    media_pending: number
  }
  inbox: { id: string; status: string; created_at: number }
  policy: { id: string; value: string; revision: number }
  route: { workspace_id: string; connection_key: string; chat_type: string; chat_id: string }
  outbox: { id: string; status: string; result: string }
  message_reference: { id: string; workspace_id: string; message_id: string }
}
export const migrations = [
  defineMigration({
    id: '001_im',
    steps: [
      {
        kind: 'createTable',
        table: 'inbox',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'status', type: 'string', notNull: true },
          { name: 'created_at', type: 'timestamp', notNull: true },
        ],
      },
      {
        kind: 'createTable',
        table: 'policy',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'value', type: 'text', notNull: true },
          { name: 'revision', type: 'integer', notNull: true },
        ],
      },
      {
        kind: 'createTable',
        table: 'route',
        columns: [
          { name: 'workspace_id', type: 'string', length: 128, primaryKey: true },
          { name: 'connection_key', type: 'string', length: 128, notNull: true },
          { name: 'chat_type', type: 'string', notNull: true },
          { name: 'chat_id', type: 'string', notNull: true },
        ],
      },
      {
        kind: 'createTable',
        table: 'outbox',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'status', type: 'string', notNull: true },
          { name: 'result', type: 'text', notNull: true },
        ],
      },
    ],
  }),
  defineMigration({
    id: '002_message_references',
    steps: [
      {
        kind: 'createTable',
        table: 'message_reference',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'workspace_id', type: 'string', length: 128, notNull: true },
          { name: 'message_id', type: 'string', length: 256, notNull: true },
        ],
      },
    ],
  }),
  defineMigration({
    id: '003_group_history',
    steps: [
      {
        kind: 'createTable',
        table: 'history',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          ...['workspace_id', 'connection_id', 'connection_key', 'sender_id'].map((name) => ({
            name,
            type: 'string' as const,
            length: 200,
            notNull: true,
          })),
          { name: 'sequence', type: 'integer', notNull: true },
          { name: 'timestamp', type: 'timestamp', notNull: true },
          { name: 'text', type: 'text', notNull: true },
          { name: 'payload', type: 'text', notNull: true },
          { name: 'media_pending', type: 'integer', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'history',
        name: 'history_sequence',
        columns: ['workspace_id', 'sequence'],
        unique: true,
      },
      {
        kind: 'createIndex',
        table: 'history',
        name: 'history_time',
        columns: ['workspace_id', 'timestamp'],
      },
      {
        kind: 'createIndex',
        table: 'history',
        name: 'history_sender',
        columns: ['workspace_id', 'sender_id', 'timestamp'],
      },
    ],
  }),
]
