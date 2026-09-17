import { defineMigration } from '@antarestra/database'

export const pluginId = '@antarestra/plugin-auth-local'
export interface Tables {
  account: {
    id: string
    instance_id: string
    email: string
    email_key: string
    password_hash: string
    password_change_required: number
    identity_id: string
    principal_id: string
    created_at: number
  }
}
export const migrations = [
  defineMigration({
    id: '001_local_account',
    steps: [
      {
        kind: 'createTable',
        table: 'account',
        columns: [
          { name: 'id', type: 'string', length: 128, primaryKey: true },
          { name: 'instance_id', type: 'string', length: 64, notNull: true },
          { name: 'email', type: 'string', length: 254, notNull: true },
          { name: 'email_key', type: 'string', length: 64, notNull: true },
          { name: 'password_hash', type: 'text', notNull: true },
          { name: 'identity_id', type: 'string', length: 128, notNull: true },
          { name: 'principal_id', type: 'string', length: 128, notNull: true },
          { name: 'created_at', type: 'timestamp', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'account',
        name: 'account_email',
        columns: ['instance_id', 'email_key'],
        unique: true,
      },
      {
        kind: 'createIndex',
        table: 'account',
        name: 'account_identity',
        columns: ['identity_id'],
        unique: true,
      },
    ],
  }),
  defineMigration({
    id: '002_password_change_required',
    steps: [
      {
        kind: 'addColumn',
        table: 'account',
        column: { name: 'password_change_required', type: 'boolean', notNull: true, default: 0 },
      },
    ],
  }),
]
