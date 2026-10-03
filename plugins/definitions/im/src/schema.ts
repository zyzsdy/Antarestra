import { defineMigration } from '@antarestra/database'
export const pluginId = '@antarestra/im'
export interface Tables {
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
]
