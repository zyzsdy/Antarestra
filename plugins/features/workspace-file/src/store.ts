import { defineMigration } from '@antarestra/database'
import type { BlobUpload } from '@antarestra/storage'
export const name = '@antarestra/plugin-workspace-file'
export interface FileEntry {
  path: string
  kind: 'file' | 'directory'
  size: number
  createdAt: number
  backend: string
  key: string
  contentType?: string
}
export interface UploadRecord {
  id: string
  path: string
  backend: string
  blob: BlobUpload
  status: 'pending' | 'complete' | 'cancelled'
}
export interface Space {
  label: string
  quota: number
  files: FileEntry[]
  uploads: UploadRecord[]
  garbage: { backend: string; key: string }[]
}
export interface Tables {
  spaces: { id: string; revision: number; payload: string }
}
export const migrations = [
  defineMigration({
    id: '001_spaces',
    steps: [
      {
        kind: 'createTable',
        table: 'spaces',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'revision', type: 'integer', notNull: true },
          { name: 'payload', type: 'text', notNull: true },
        ],
      },
    ],
  }),
]
export function usage(space: Space) {
  const used = space.files.reduce((sum, f) => sum + f.size, 0)
  const reserved = space.uploads
    .filter((u) => u.status === 'pending')
    .reduce((sum, u) => sum + u.blob.size, 0)
  return { used, reserved, quota: space.quota }
}
