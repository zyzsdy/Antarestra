import { defineMigration } from '@antarestra/database'
export const name = '@antarestra/plugin-ai-provider'
export interface Tables {
  providers: { id: string; payload: string }
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
]
