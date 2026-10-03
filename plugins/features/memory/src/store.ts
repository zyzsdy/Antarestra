import { defineMigration } from '@antarestra/database'
import type { Column } from '@antarestra/database'

export const pluginId = '@antarestra/plugin-memory'
export interface GlobalRow {
  workspace_id: string
  content: string
  revision: number
  tokens: number
  updated_at: number
}
export interface DocumentRow {
  id: string
  workspace_id: string
  content: string
  revision: number
  created_at: number
  updated_at: number
  created_conversation_id: string
}
export interface Tables {
  globals: GlobalRow
  documents: DocumentRow
  links: { workspace_id: string; memory_id: string; conversation_id: string }
  chunks: {
    workspace_id: string
    memory_id: string
    part: number
    content: string
    search_text: string
  }
}
const string = (name: string, primaryKey = false): Column => ({
  name,
  type: 'string',
  length: 200,
  notNull: true,
  primaryKey,
})
const integer = (name: string): Column => ({ name, type: 'integer', notNull: true })
const text = (name: string): Column => ({ name, type: 'text', notNull: true })
export const migrations = [
  defineMigration({
    id: '001_memory',
    steps: [
      {
        kind: 'createTable',
        table: 'globals',
        columns: [
          string('workspace_id', true),
          text('content'),
          integer('revision'),
          integer('tokens'),
          integer('updated_at'),
        ],
      },
      {
        kind: 'createTable',
        table: 'documents',
        columns: [
          string('id', true),
          string('workspace_id'),
          text('content'),
          integer('revision'),
          integer('created_at'),
          integer('updated_at'),
          string('created_conversation_id'),
        ],
      },
      {
        kind: 'createTable',
        table: 'links',
        columns: [
          string('workspace_id', true),
          string('memory_id', true),
          string('conversation_id', true),
        ],
      },
      {
        kind: 'createTable',
        table: 'chunks',
        columns: [
          string('workspace_id', true),
          string('memory_id', true),
          { ...integer('part'), primaryKey: true },
          text('content'),
          text('search_text'),
        ],
      },
      {
        kind: 'createIndex',
        table: 'documents',
        name: 'documents_workspace',
        columns: ['workspace_id', 'updated_at', 'id'],
      },
      {
        kind: 'createIndex',
        table: 'links',
        name: 'links_conversation',
        columns: ['workspace_id', 'conversation_id'],
      },
      {
        kind: 'createFullTextIndex',
        table: 'chunks',
        name: 'chunks_search',
        column: 'search_text',
      },
    ],
  }),
]
