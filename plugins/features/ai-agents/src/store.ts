import { defineMigration } from '@antarestra/database'
export const name = '@antarestra/plugin-ai-agents'
export interface Tables {
  agents: { id: string; payload: string }
}
export const migrations = [
  defineMigration({
    id: '001_agents',
    steps: [
      {
        kind: 'createTable',
        table: 'agents',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'payload', type: 'text', notNull: true },
        ],
      },
    ],
  }),
]
