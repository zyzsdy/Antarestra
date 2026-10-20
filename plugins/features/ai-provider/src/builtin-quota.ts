import { randomUUID } from 'node:crypto'
import type { DatabaseScope } from '@antarestra/database'
import type { ProviderRecord } from './types.js'
import type { Tables } from './store.js'

export const builtinLimitMessage = '本工具已用完5小时调用限制'
export const builtinWindowMs = 5 * 60 * 60 * 1000

export class BuiltinQuota {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private db: () => DatabaseScope<Tables>) {}

  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.catch(() => {})
    return result
  }

  reserve(provider: ProviderRecord, workspace_id: string, names: string[]) {
    return this.lock(async () => {
      const db = this.db()
      const cutoff = new Date(Date.now() - builtinWindowMs).toISOString()
      return db.transaction(async (tx) => {
        await tx.deleteFrom('builtin_usage').where('created_at', '<=', cutoff).execute()
        const rows = await tx
          .selectFrom('builtin_usage')
          .selectAll()
          .where('workspace_id', '=', workspace_id)
          .where('provider_id', '=', provider.id)
          .execute()
        const tools = (provider.builtinTools ?? []).filter((tool) => names.includes(tool.name))
        const remaining = tools.map((tool) => ({
          tool,
          available: tool.callsPer5Hours
            ? Math.max(
                0,
                tool.callsPer5Hours -
                  rows
                    .filter((row) => row.tool_type === tool.type)
                    .reduce((sum, row) => sum + row.calls, 0),
              )
            : Infinity,
        }))
        const blocked = remaining.filter((item) => !item.available).map((item) => item.tool.name)
        const allowed = remaining.filter((item) => item.available > 0)
        const reservations = new Map<string, string>()
        for (const { tool } of allowed) {
          if (!tool.callsPer5Hours) continue
          const id = randomUUID()
          reservations.set(tool.name, id)
          await tx
            .insertInto('builtin_usage')
            .values({
              id,
              workspace_id,
              provider_id: provider.id,
              tool_type: tool.type,
              created_at: new Date().toISOString(),
              // 每个在途请求预占一次，避免并发请求重复使用最后一份额度。
              calls: 1,
            })
            .execute()
        }
        return {
          blocked,
          // 只有完整响应能证明未使用的预占可释放；断线、取消和崩溃保守保留。
          finish: (counts: Map<string, number>, completed: boolean) =>
            this.lock(async () => {
              await this.db().transaction(async (settle) => {
                for (const { tool } of allowed) {
                  const calls = counts.get(tool.name) ?? 0
                  const id = reservations.get(tool.name)
                  if (id) {
                    if (!completed && calls <= 1) continue
                    if (!calls)
                      await settle.deleteFrom('builtin_usage').where('id', '=', id).execute()
                    else
                      await settle
                        .updateTable('builtin_usage')
                        .set({ calls, created_at: new Date().toISOString() })
                        .where('id', '=', id)
                        .execute()
                  } else if (calls) {
                    await settle
                      .insertInto('builtin_usage')
                      .values({
                        id: randomUUID(),
                        workspace_id,
                        provider_id: provider.id,
                        tool_type: tool.type,
                        created_at: new Date().toISOString(),
                        calls,
                      })
                      .execute()
                  }
                }
              })
            }),
        }
      })
    })
  }
}
