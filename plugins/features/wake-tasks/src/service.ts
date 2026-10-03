import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { AiError } from '@antarestra/ai'
import type { JsonObject, RunContext, Access, AiService } from '@antarestra/ai'
import type { DatabaseScope } from '@antarestra/database'
import { pluginId } from './store.js'
import type { Tables, TaskRow } from './store.js'
import { nextOccurrence, schedule } from './schedule.js'

export interface Config {
  pollIntervalMs: number
  batchSize: number
  concurrency: number
  leaseMs: number
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    wakeTasks: WakeTasksService
  }
}

function view(row: TaskRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceConversationId: row.source_conversation_id,
    agentId: row.agent_id,
    reason: row.reason,
    prompt: row.prompt,
    mode: row.interval_ms === null ? 'once' : 'interval',
    intervalSeconds: row.interval_ms === null ? null : row.interval_ms / 1000,
    triggerAt: new Date(row.trigger_at).toISOString(),
    nextTriggerAt: ['pending', 'running'].includes(row.status)
      ? new Date(row.next_at).toISOString()
      : null,
    status: row.status,
    lastConversationId: row.last_conversation_id,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
  }
}

export class WakeTasksService extends Service<Config> {
  private readonly ai: AiService
  private active = true
  private readonly abort = new AbortController()
  private readonly workers = new Map<string, Promise<void>>()
  private polling: Promise<void> | undefined
  private readonly db: DatabaseScope<Tables>
  private timer: ReturnType<typeof setTimeout> | undefined
  // 固定构造时的实例；若在 arm 中捕获代理 this，每轮会继续叠加 Cordis shadow。
  private readonly onTimer = () => {
    void this.tick()
  }

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'wakeTasks')
    this.ai = ctx.ai
    this.db = ctx.database.scope<Tables>(ctx, pluginId)
    ctx.effect(() => async () => {
      this.active = false
      clearTimeout(this.timer)
      this.abort.abort()
      await this.polling
      await Promise.all(this.workers.values())
    })
  }

  private live() {
    if (!this.active) throw new AiError('wake_tasks_unavailable', '定时唤醒服务已卸载', 503)
  }
  async create(args: JsonObject, context: RunContext) {
    this.live()
    const input = schedule(args)
    const source = await this.ai.backgroundSource(context)
    this.live()
    context.signal.throwIfAborted()
    const row: TaskRow = {
      id: randomUUID(),
      workspace_id: context.workspaceId,
      actor_id: context.actorId,
      source: source.source,
      source_provider: source.providerId,
      source_conversation_id: context.conversationId,
      agent_id: context.agent.id,
      reason: input.reason,
      prompt: input.prompt,
      interval_ms: input.interval,
      trigger_at: input.at,
      next_at: input.at,
      available_at: input.at,
      status: 'pending',
      lease_token: '',
      conversation_id: randomUUID(),
      last_conversation_id: null,
      last_run_id: null,
      last_error: null,
      attempts: 0,
      created_at: Date.now(),
    }
    await this.db.transaction(async (db) => {
      this.live()
      context.signal.throwIfAborted()
      await db.insertInto('tasks').values(row).execute()
      this.live()
      context.signal.throwIfAborted()
    })
    return view(row)
  }
  async list(context: RunContext, after = '', limit = 20) {
    this.live()
    await this.ai.authorizeRunContext(context, true)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof after !== 'string' ||
      after.length > 200
    )
      throw new AiError('invalid_schedule', '分页参数无效')
    const rows = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('workspace_id', '=', context.workspaceId)
      .where('id', '>', after)
      .orderBy('id')
      .limit(limit + 1)
      .execute()
    return {
      tasks: rows.slice(0, limit).map(view),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
    }
  }
  async cancel(context: RunContext, id: string) {
    this.live()
    await this.ai.authorizeRunContext(context, true)
    const result = await this.db
      .updateTable('tasks')
      .set({ status: 'cancelled', lease_token: '' })
      .where('id', '=', id)
      .where('workspace_id', '=', context.workspaceId)
      .where('status', 'in', ['pending', 'running'])
      .executeTakeFirst()
    if (result.numUpdatedRows !== 1n)
      throw new AiError('task_not_found', '任务不存在、不可访问或已结束', 404)
    return { id, status: 'cancelled' }
  }

  /** 启动立即查询；每次只读剩余并发容量以内的一批任务，不加载全量队列。 */
  start() {
    this.arm(0)
  }
  private arm(ms: number) {
    if (!this.active) return
    clearTimeout(this.timer)
    this.timer = setTimeout(this.onTimer, ms)
    this.timer.unref()
  }
  async tick() {
    if (!this.active) return
    if (this.polling) return this.polling
    this.polling = this.poll()
      .catch(() => {
        // 不输出驱动错误，避免泄露 SQL、提示词和连接凭据；下次轮询自动恢复。
        this.ctx.logger.warn('定时唤醒任务读库失败，将在下次轮询重试')
      })
      .finally(() => {
        this.polling = undefined
        this.arm(this.config.pollIntervalMs)
      })
    return this.polling
  }
  private async poll() {
    const limit = Math.min(this.config.batchSize, this.config.concurrency - this.workers.size)
    if (limit <= 0) return
    const now = Date.now()
    // 分别使用 (status, available_at, id) 索引，避免 OR 和全表排序。
    const rows = (
      await Promise.all(
        (['pending', 'running'] as const).map((status) =>
          this.db
            .selectFrom('tasks')
            .selectAll()
            .where('status', '=', status)
            .where('available_at', '<=', now)
            .orderBy('available_at')
            .orderBy('id')
            .limit(limit)
            .execute(),
        ),
      )
    )
      .flat()
      .sort((a, b) => a.available_at - b.available_at || a.id.localeCompare(b.id))
      .slice(0, limit)
    for (const row of rows) {
      if (!this.active) return
      if (this.workers.has(row.id)) continue
      const token = randomUUID()
      const claimed = await this.db
        .updateTable('tasks')
        .set({
          status: 'running',
          lease_token: token,
          available_at: Date.now() + this.config.leaseMs,
        })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .where('lease_token', '=', row.lease_token)
        .where('available_at', '=', row.available_at)
        .executeTakeFirst()
      if (claimed.numUpdatedRows !== 1n) continue
      const worker = this.execute(row, token)
        .catch(() => {
          this.ctx.logger.warn('定时唤醒任务保存失败，将在租约到期后恢复')
        })
        .finally(() => {
          this.workers.delete(row.id)
          this.arm(0)
        })
      this.workers.set(row.id, worker)
    }
  }
  private owned(id: string, token: string) {
    return this.db
      .updateTable('tasks')
      .where('id', '=', id)
      .where('status', '=', 'running')
      .where('lease_token', '=', token)
  }
  private async renew(id: string, token: string) {
    this.live()
    const result = await this.owned(id, token)
      .set({ available_at: Date.now() + this.config.leaseMs })
      .executeTakeFirst()
    if (result.numUpdatedRows !== 1n) throw new AiError('lease_lost', '任务已取消或租约已转移')
  }
  private async execute(row: TaskRow, token: string) {
    let access: Access | undefined
    let runId: string | undefined
    try {
      this.live()
      access = await this.ai.authorizeBackground(
        this.ctx,
        row.source,
        row.actor_id,
        row.workspace_id,
        row.source_provider,
      )
      await this.renew(row.id, token)
      await this.ai.createConversation(
        access,
        row.agent_id,
        `定时任务：${row.reason}`.slice(0, 200),
        row.conversation_id,
      )
      await this.renew(row.id, token)
      const run = await this.ai.start(access, row.conversation_id, {
        operation: 'send',
        input: { text: row.prompt },
        idempotencyKey: row.conversation_id,
        expectedRevision: 0,
        expectedNodeId: null,
      })
      runId = run.id
      await this.owned(row.id, token)
        .set({ last_conversation_id: row.conversation_id, last_run_id: run.id })
        .execute()
      while (true) {
        await this.renew(row.id, token)
        const current = await this.ai.getRun(access, run.id)
        if (current.status !== 'running') {
          const error =
            current.status === 'completed'
              ? null
              : current.error?.code === 'model_output_truncated'
                ? '模型达到输出上限，回复未完整生成，请查看执行会话'
                : `AI 运行${current.status === 'cancelled' ? '已取消' : '失败'}，请查看执行会话`
          const next =
            row.interval_ms === null
              ? null
              : nextOccurrence(row.next_at, row.interval_ms, Date.now())
          await this.owned(row.id, token)
            .set({
              status: next === null ? (error ? 'failed' : 'completed') : 'pending',
              next_at: next ?? row.next_at,
              available_at: next ?? row.next_at,
              conversation_id: next === null ? row.conversation_id : randomUUID(),
              lease_token: '',
              attempts: 0,
              last_error: error,
            })
            .execute()
          return
        }
        await delay(Math.min(1000, this.config.leaseMs / 3), undefined, {
          signal: this.abort.signal,
        })
      }
    } catch (error) {
      // 使用已捕获的运行对象取消，不因身份撤销或服务卸载而阻塞资源回收。
      if (runId) await this.ai.running.get(runId)?.cancel()
      // 所属数据库作用域已随插件失效；保留租约，由重载后的调度器回收。
      if (!this.active) return
      const forbidden =
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        (error.status === 401 || error.status === 403)
      await this.owned(row.id, token)
        .set({
          status: forbidden ? 'failed' : 'pending',
          lease_token: '',
          attempts: Math.min(row.attempts + 1, 20),
          available_at:
            Date.now() + (this.active ? Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)) : 0),
          last_error: forbidden ? '后台账号或空间授权已失效' : '执行中断或服务暂不可用，将自动恢复',
        })
        .execute()
    }
  }
}
