import type { Context } from '@antarestra/plugin-sdk'
import { AiError } from '@antarestra/ai'
import { ImError } from '@antarestra/im'
import type { AiHistoryEntry } from '@antarestra/im'
import { pluginId, type JobRow, type Tables } from './store.js'

const summary = (row: JobRow): AiHistoryEntry => ({
  id: row.id,
  conversationId: row.conversation_id,
  runId: row.run_id,
  status: row.status,
  delivery: row.delivery,
  createdAt: row.created_at,
  inputPreview: row.input.length > 120 ? `${row.input.slice(0, 120)}…` : row.input,
  hasAnswer: !!row.answer,
})

export function registerInspection(
  ctx: Context,
  exclusive: (workspaceId: string, task: () => Promise<void>) => Promise<void>,
) {
  const db = () => ctx.database.scope<Tables>(ctx, pluginId)
  ctx.im.registerAiHistory(ctx, {
    async remove(workspaceId, removeMessages) {
      await exclusive(workspaceId, async () => {
        await ctx.ai
          .deleteWorkspaceHistory(workspaceId, async (transaction) => {
            const scope = transaction.scope<Tables>(ctx, pluginId)
            const pending = await scope
              .selectFrom('jobs')
              .select('id')
              .where('workspace_id', '=', workspaceId)
              .where((eb) =>
                eb.or([eb('status', 'in', ['queued', 'running']), eb('delivery', '=', 'pending')]),
              )
              .executeTakeFirst()
            if (pending)
              throw new ImError(
                409,
                'busy',
                '请等待该群的 AI 任务和消息投递结束，或先停止任务，再永久删除',
              )
            for (const table of ['jobs', 'sessions', 'cursors', 'statuses'] as const)
              await scope.deleteFrom(table).where('workspace_id', '=', workspaceId).execute()
            await removeMessages(transaction)
          })
          .catch((error: unknown) => {
            if (error instanceof AiError) throw new ImError(error.status, error.code, error.message)
            throw error
          })
      })
    },
    async list(workspaceId, offset, limit) {
      const query = db().selectFrom('jobs').where('workspace_id', '=', workspaceId)
      const count = await query
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .executeTakeFirstOrThrow()
      const rows = await query
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute()
      const session = await db()
        .selectFrom('sessions')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst()
      return {
        entries: rows.map(summary),
        total: Number(count.total),
        currentConversationId: session?.conversation_id ?? null,
      }
    },
    async detail(workspaceId, id) {
      const row = await db()
        .selectFrom('jobs')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst()
      if (!row) return undefined
      let run = null
      if (row.run_id) {
        try {
          const record = await ctx.ai.inspectRun(workspaceId, row.run_id)
          run = {
            status: record.status,
            model: record.model,
            messages: record.messages,
            requests: record.requests,
            error: record.error,
            endedAt: record.endedAt,
          }
        } catch (error) {
          if (!(error && typeof error === 'object' && 'status' in error && error.status === 404))
            throw error
        }
      }
      return { ...summary(row), input: row.input, answer: row.answer, run }
    },
  })
}
