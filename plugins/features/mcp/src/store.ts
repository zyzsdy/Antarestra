import { defineMigration } from '@antarestra/database'
export const name = '@antarestra/plugin-mcp'
export interface Tables {
  servers: { id: string; payload: string; position: number }
}
export const migrations = [
  defineMigration({
    id: '001_servers',
    steps: [
      {
        kind: 'createTable',
        table: 'servers',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'payload', type: 'text', notNull: true },
          { name: 'position', type: 'integer', notNull: true },
        ],
      },
    ],
  }),
]
