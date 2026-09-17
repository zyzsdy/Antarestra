import { defineMigration } from '@antarestra/database'
import type { Column, SchemaStep } from '@antarestra/database'

export const pluginId = '@antarestra/rbac'
export interface Principal {
  id: string
  kind: 'person' | 'group' | 'service'
  display_name: string
  status: 'active' | 'disabled'
  created_at: number
}
export interface Tables {
  principal: Principal
  provider: { id: string; plugin_id: string; status: string }
  identity: {
    id: string
    principal_id: string
    provider_id: string
    subject: string
    status: string
  }
  session: { id: string; identity_id: string; token_hash: string; expires_at: number }
  role: { id: string; name: string; status: string }
  role_permission: { role_id: string; permission: string }
  role_migration: { id: string }
  binding: {
    principal_id: string
    role_id: string
    scope: string
    scope_key: string
    source: string
    expires_at: number | null
  }
}

const key = (name: string): Column => ({ name, type: 'string', length: 128, primaryKey: true })
const str = (name: string): Column => ({ name, type: 'string', length: 128, notNull: true })
const table = (table: string, columns: Column[]): SchemaStep => ({
  kind: 'createTable',
  table,
  columns,
})
export const migrations = [
  defineMigration({
    id: '001_identity_rbac',
    steps: [
      table('principal', [
        key('id'),
        str('kind'),
        str('display_name'),
        str('status'),
        { name: 'created_at', type: 'timestamp', notNull: true },
      ]),
      table('provider', [key('id'), str('plugin_id'), str('status')]),
      table('identity', [
        key('id'),
        str('principal_id'),
        str('provider_id'),
        str('subject'),
        str('status'),
      ]),
      {
        kind: 'createIndex',
        table: 'identity',
        name: 'identity_subject',
        columns: ['provider_id', 'subject'],
        unique: true,
      },
      table('session', [
        key('id'),
        str('identity_id'),
        str('token_hash'),
        { name: 'expires_at', type: 'timestamp', notNull: true },
      ]),
      {
        kind: 'createIndex',
        table: 'session',
        name: 'session_token',
        columns: ['token_hash'],
        unique: true,
      },
      table('role', [key('id'), str('name'), str('status')]),
      table('role_permission', [key('role_id'), key('permission')]),
      table('binding', [
        key('principal_id'),
        key('role_id'),
        str('scope'),
        key('scope_key'),
        key('source'),
        { name: 'expires_at', type: 'timestamp' },
      ]),
    ],
  }),
  defineMigration({
    id: '002_builtin_roles',
    steps: [table('role_migration', [key('id')])],
  }),
]
