import { defineMigration } from '@antarestra/database'
import type { Queries } from '@antarestra/database'
import type { AiEvent, Conversation, MessageNode, RunRecord } from '@antarestra/contracts'
export const pluginId = '@antarestra/ai'
interface RecordRow {
  id: string
  workspace_id: string
  conversation_id: string
  payload: string
}
interface RunRow extends RecordRow {
  request_key: string
  fingerprint: string
  status: string
}
interface EventRow {
  run_id: string
  sequence: number
  payload: string
}
export interface Tables {
  summaries: RecordRow
  conversations: RecordRow & { last_activity_at: number | null; archived_at: number | null }
  nodes: RecordRow
  runs: RunRow
  events: EventRow
}
export const migrations = [
  defineMigration({
    id: '001_ai_core',
    steps: [
      ...(['conversations', 'nodes', 'runs'] as const).map((table) => ({
        kind: 'createTable' as const,
        table,
        columns: [
          { name: 'id', type: 'string' as const, length: 200, primaryKey: true },
          { name: 'workspace_id', type: 'string' as const, length: 200, notNull: true },
          { name: 'conversation_id', type: 'string' as const, length: 200, notNull: true },
          { name: 'payload', type: 'text' as const, notNull: true },
          ...(table === 'runs'
            ? [
                { name: 'request_key', type: 'string' as const, length: 200, notNull: true },
                { name: 'fingerprint', type: 'text' as const, notNull: true },
                { name: 'status', type: 'string' as const, length: 32, notNull: true },
              ]
            : []),
        ],
      })),
      {
        kind: 'createTable',
        table: 'events',
        columns: [
          { name: 'run_id', type: 'string', length: 200, notNull: true },
          { name: 'sequence', type: 'integer', notNull: true },
          { name: 'payload', type: 'text', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'events',
        name: 'run_sequence',
        columns: ['run_id', 'sequence'],
        unique: true,
      },
      {
        kind: 'createIndex',
        table: 'runs',
        name: 'request_key',
        columns: ['conversation_id', 'request_key'],
        unique: true,
      },
      {
        kind: 'createIndex',
        table: 'nodes',
        name: 'conversation_nodes',
        columns: ['conversation_id'],
      },
    ],
  }),
  defineMigration({
    id: '002_conversation_history',
    steps: [
      {
        kind: 'addColumn',
        table: 'conversations',
        column: { name: 'last_activity_at', type: 'timestamp' },
      },
      {
        kind: 'addColumn',
        table: 'conversations',
        column: { name: 'archived_at', type: 'timestamp' },
      },
      {
        kind: 'createIndex',
        table: 'conversations',
        name: 'workspace_history',
        columns: ['workspace_id', 'archived_at', 'last_activity_at', 'id'],
      },
    ],
  }),
  defineMigration({
    id: '003_context_summaries',
    steps: [
      {
        kind: 'createTable',
        table: 'summaries',
        columns: [
          { name: 'id', type: 'string', length: 200, primaryKey: true },
          { name: 'workspace_id', type: 'string', length: 200, notNull: true },
          { name: 'conversation_id', type: 'string', length: 200, notNull: true },
          { name: 'payload', type: 'text', notNull: true },
        ],
      },
      {
        kind: 'createIndex',
        table: 'summaries',
        name: 'conversation_summaries',
        columns: ['workspace_id', 'conversation_id'],
      },
    ],
  }),
]
export const conversationFields = (value: Conversation) => ({
  payload: JSON.stringify(value),
  last_activity_at: value.lastActivityAt,
  archived_at: value.archivedAt,
})
export const decode = <T>(row: { payload: string }): T => JSON.parse(row.payload) as T
export const row = (value: Conversation | MessageNode | RunRecord, workspaceId: string) => ({
  id: value.id,
  workspace_id: workspaceId,
  conversation_id: 'agentId' in value ? value.id : value.conversationId,
  payload: JSON.stringify(value),
})
export async function saveRun(db: Queries<Tables>, run: RunRecord) {
  await db
    .updateTable('runs')
    .set({ payload: JSON.stringify(run), status: run.status })
    .where('id', '=', run.id)
    .execute()
}
export async function appendEvent(db: Queries<Tables>, event: AiEvent) {
  await db
    .insertInto('events')
    .values({ run_id: event.runId, sequence: event.sequence, payload: JSON.stringify(event) })
    .execute()
}
