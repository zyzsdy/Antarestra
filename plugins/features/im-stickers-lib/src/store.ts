import { defineMigration } from '@antarestra/database'

export const pluginId = '@antarestra/plugin-im-stickers-lib'
export const libraryWorkspace = 'library:im-stickers'
export interface Sticker {
  id: string
  title: string
  description: string
  category: string
  revision: number
}
export interface Tables {
  stickers: Sticker
  garbage: { id: string }
}
export const migrations = [
  defineMigration({
    id: '001_stickers',
    steps: [
      {
        kind: 'createTable',
        table: 'stickers',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'title', type: 'string', length: 100, notNull: true },
          { name: 'description', type: 'text', notNull: true },
          { name: 'category', type: 'string', length: 100, notNull: true },
          { name: 'revision', type: 'integer', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'stickers',
        name: 'unique_title',
        columns: ['title'],
        unique: true,
      },
      {
        kind: 'createTable',
        table: 'garbage',
        columns: [{ name: 'id', type: 'string', length: 200, primaryKey: true }],
      },
    ],
  }),
]
