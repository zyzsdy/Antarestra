import { defineMigration } from '@antarestra/database'
export const pluginId = '@antarestra/plugin-identity-im'
export interface Tables {
  actor: { id: string; principal_id: string; connection_key: string; sender_id: string }
  workspace: {
    id: string
    connection_key: string
    connection_id: string
    platform: string
    account_id: string
    tenant_id: string
    chat_type: 'private' | 'group'
    chat_id: string
    label: string
    active: number
  }
  member: { actor_id: string; workspace_id: string; active: number }
}
export const migrations = [
  defineMigration({
    id: '001_im_identity',
    steps: [
      {
        kind: 'createTable',
        table: 'actor',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'principal_id', type: 'string', length: 128, notNull: true },
          { name: 'connection_key', type: 'string', length: 128, notNull: true },
          { name: 'sender_id', type: 'string', length: 128, notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'actor',
        name: 'actor_principal',
        columns: ['principal_id'],
        unique: true,
      },
      {
        kind: 'createTable',
        table: 'workspace',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'connection_key', type: 'string', length: 128, notNull: true },
          { name: 'connection_id', type: 'string', length: 128, notNull: true },
          { name: 'platform', type: 'string', length: 128, notNull: true },
          { name: 'account_id', type: 'string', length: 128, notNull: true },
          { name: 'tenant_id', type: 'string', length: 128, notNull: true },
          { name: 'chat_type', type: 'string', length: 128, notNull: true },
          { name: 'chat_id', type: 'string', length: 128, notNull: true },
          { name: 'label', type: 'text', notNull: true },
          { name: 'active', type: 'integer', notNull: true },
        ],
      },
      {
        kind: 'createTable',
        table: 'member',
        columns: [
          { name: 'actor_id', type: 'string', length: 128, primaryKey: true },
          { name: 'workspace_id', type: 'string', length: 128, primaryKey: true },
          { name: 'active', type: 'integer', notNull: true },
        ],
      },
    ],
  }),
]
