import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import type { Access, RunCommand } from '@antarestra/ai'
import type { MessageContext } from '@antarestra/im'
import '@antarestra/plugin-im-commands'
import { activationReason, finalText } from './messages.js'
import {
  prepareInput,
  renderInput,
  defaultInputTemplate,
  refreshAttachments,
  type InputSnapshot,
} from './history.js'
import { registerHistoryTools } from './tools.js'
import { dynamicReplyDefaults } from '@antarestra/im/activation'
import { dynamicReplyProbability, recordDynamicActivation } from './dynamic-reply.js'
import type { DynamicReplyState } from './dynamic-reply.js'
import { pluginId } from './store.js'
import type { JobRow, Tables } from './store.js'

export interface Config {
  pollIntervalMs: number
  queueLimit: number
  deliveryAttempts: number
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    imAi: ImAiService
  }
}
export class ImAiService extends Service<Config> {
  private readonly abort = new AbortController()
  private readonly workers = new Map<string, Promise<void>>()
  private readonly requests = new Map<string, MessageContext>()
  private readonly activeRuns = new Map<string, string>()
  private readonly activatedAt = new Map<string, number[]>()
  private readonly lastActivatedAt = new Map<string, number>()
  private readonly dynamicReplies = new Map<string, DynamicReplyState>()
  private readonly admission = new Map<string, Promise<unknown>>()
  private readonly epochs = new Map<string, number>()
  private readonly stopping = new Set<string>()
  private polling = false
  private active = true
  private readonly ai
  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'imAi')
    this.ai = ctx.ai
    registerHistoryTools(ctx, async (context) => {
      const run = this.ai.running.get(context.runId)
      const jobId = run?.record.input.variables?.imJobId
      if (typeof jobId !== 'string') return undefined
      const job = await this.db
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', jobId)
        .where('workspace_id', '=', context.workspaceId)
        .where('actor_id', '=', context.actorId)
        .where('conversation_id', '=', context.conversationId)
        .executeTakeFirst()
      return job?.snapshot ? (JSON.parse(job.snapshot) as InputSnapshot) : undefined
    })
    ctx.im.registerHandler(ctx, {
      id: 'im-ai',
      stage: 'ai',
      handle: (message) => this.handle(message),
    })
    ctx.imCommands.register(ctx, {
      name: 'stop',
      description: '停止当前空间 AI 并清空等待消息',
      permission: 'ai.chat.use',
      maxArgs: 0,
      execute: async (message) => {
        await this.stop(message)
        return '已停止当前空间 AI，等待消息已清空。'
      },
    })
    ctx.imCommands.register(ctx, {
      name: 'reset',
      description: '在当前空间开启新的 AI 会话',
      permission: 'ai.chat.use',
      maxArgs: 0,
      execute: async (message) => {
        await this.stop(message)
        await this.db
          .deleteFrom('sessions')
          .where('workspace_id', '=', message.workspaceId)
          .execute()
        return '已重置 AI 上下文；下一次激活将建立新会话。'
      },
    })
    const timer = setInterval(
      () => {
        void this.pump()
      },
      Math.max(250, config.pollIntervalMs),
    )
    ctx.effect(() => async () => {
      this.active = false
      clearInterval(timer)
      this.abort.abort()
      await Promise.allSettled(
        [...this.activeRuns.values()].map((id) => this.ai.running.get(id)?.cancel()),
      )
      await Promise.allSettled([...this.workers.values(), ...this.admission.values()])
      this.requests.clear()
      this.lastActivatedAt.clear()
      this.dynamicReplies.clear()
    })
  }
  private get db() {
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  private serial<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.admission.get(workspace) ?? Promise.resolve()).then(operation)
    const settled = task.catch(() => {})
    this.admission.set(workspace, settled)
    void task
      .finally(() => {
        if (this.admission.get(workspace) === settled) this.admission.delete(workspace)
      })
      .catch(() => {})
    return task
  }
  private handle(message: MessageContext) {
    return this.serial(message.workspaceId, async () => {
      const policy = this.ctx.im.getChatPolicy(message.connection.id, message.message.chat)
      const dynamic = message.message.chat.type === 'group' ? policy.activation?.dynamic : undefined
      if (!dynamic || !policy.enabled || policy.ai === false)
        this.dynamicReplies.delete(message.workspaceId)
      if (!this.active || !policy.enabled || policy.ai === false) return 'continue' as const
      const now = Date.now()
      const hasContent = message.message.segments.some((segment) =>
        segment.type === 'text' ? !!segment.text.trim() : 'url' in segment,
      )
      let dynamicState: DynamicReplyState | undefined
      let dynamicActivated = false
      if (dynamic && hasContent) {
        dynamicState = this.dynamicReplies.get(message.workspaceId) ?? { silentMessages: 0 }
        dynamicState.silentMessages = Math.min(
          dynamicState.silentMessages + 1,
          dynamic.maxSilentMessages ?? dynamicReplyDefaults.maxSilentMessages,
        )
        this.dynamicReplies.set(message.workspaceId, dynamicState)
        dynamicActivated = Math.random() < dynamicReplyProbability(dynamic, dynamicState, now)
      }
      const reason = activationReason(message, policy.activation, dynamicActivated)
      if (!reason) return 'continue' as const
      const times = (this.activatedAt.get(message.workspaceId) ?? []).filter(
        (time) => now - time < 60000,
      )
      const last = this.lastActivatedAt.get(message.workspaceId)
      if (
        (last !== undefined && now - last < (policy.activation?.cooldownMs ?? 0)) ||
        times.length >= (policy.activation?.maxPerMinute ?? 20)
      )
        return 'consumed' as const
      const id = createHash('sha256')
        .update(JSON.stringify([message.workspaceId, message.message.id]))
        .digest('hex')
      if (await this.db.selectFrom('jobs').select('id').where('id', '=', id).executeTakeFirst())
        return 'consumed' as const
      const waiting = await this.db
        .selectFrom('jobs')
        .select('id')
        .where('workspace_id', '=', message.workspaceId)
        .where('status', '=', 'queued')
        .execute()
      if (
        waiting.length >= Math.min(100, Math.max(1, policy.queueLimit ?? this.config.queueLimit))
      ) {
        await message.reply([{ type: 'text', text: '当前等待消息较多，请稍后重试。' }])
        return 'consumed' as const
      }
      const cursor = await this.db
        .selectFrom('cursors')
        .selectAll()
        .where('workspace_id', '=', message.workspaceId)
        .executeTakeFirst()
      const history = message.archived
        ? await this.ctx.im.history(message.workspaceId, {
            afterSequence: cursor?.sequence ?? 0,
            beforeSequence: message.archived.sequence,
            limit: policy.historyLimit ?? 50,
          })
        : []
      const access = await this.ai.authorize('im', message.request)
      const catalog = await this.ai.catalog(access)
      const agent = catalog.agents.find(
        (agent) => agent.id === (policy.agentId ?? this.ai.defaultAgentId),
      )
      const defaultTemplate =
        policy.userInputTemplate ?? defaultInputTemplate(message.message.chat.type)
      const templateUsage = agent
        ? `${agent.systemTemplate}\n${agent.userTemplate.replace(/\{\{\s*input\s*\}\}/g, () => defaultTemplate)}`
        : defaultTemplate
      const model =
        agent &&
        catalog.providers
          .find((provider) => provider.id === agent.defaultModel.providerId)
          ?.models.find((model) => model.id === agent.defaultModel.modelId)
      const prepared = await this.ctx.im.preparePrivateMedia(message)
      const snapshot = prepareInput(prepared, history, policy, reason, templateUsage, model?.input)
      const input = renderInput(snapshot)
      await this.db.transaction(async (db) => {
        await db
          .insertInto('jobs')
          .values({
            id,
            workspace_id: message.workspaceId,
            actor_id: message.actorId,
            connection_id: message.connection.id,
            chat_type: message.message.chat.type,
            chat_id: message.message.chat.id,
            input,
            snapshot: JSON.stringify(snapshot),
            conversation_id: null,
            command: null,
            run_id: null,
            status: 'queued',
            answer: null,
            delivery: 'pending',
            attempts: 0,
            created_at: now,
          })
          .execute()
        if (message.archived) {
          await db.deleteFrom('cursors').where('workspace_id', '=', message.workspaceId).execute()
          await db
            .insertInto('cursors')
            .values({
              workspace_id: message.workspaceId,
              sequence: Math.max(cursor?.sequence ?? 0, message.archived.sequence),
            })
            .execute()
        }
      })
      this.requests.set(id, message)
      if (dynamic && dynamicState) recordDynamicActivation(dynamic, dynamicState, now)
      this.activatedAt.set(message.workspaceId, [...times, now])
      this.lastActivatedAt.set(message.workspaceId, now)
      void this.pump()
      return 'consumed' as const
    })
  }
  private async pump() {
    if (!this.active || this.polling) return
    this.polling = true
    try {
      const now = Date.now()

      for (const [workspace, times] of this.activatedAt) {
        if (!times.some((time) => now - time < 60000)) this.activatedAt.delete(workspace)
      }
      const online = this.ctx.im
        .listConnections()
        .filter((connection) => connection.status === 'online')
        .map((connection) => connection.id)
      if (!online.length) return
      const rows = await this.db
        .selectFrom('jobs')
        .selectAll()
        .where('delivery', '=', 'pending')
        .where('connection_id', 'in', online)
        .orderBy('created_at')
        .orderBy('id')
        .limit(200)
        .execute()
      for (const row of rows) {
        if (
          !this.active ||
          this.workers.has(row.workspace_id) ||
          this.stopping.has(row.workspace_id)
        )
          continue
        const task = this.execute(row).catch(() => {
          if (this.active) this.ctx.logger.warn('IM AI 消息处理暂不可用，将在恢复后继续')
        })
        this.workers.set(row.workspace_id, task)
        void task
          .finally(() => {
            this.workers.delete(row.workspace_id)
          })
          .catch(() => {})
      }
    } catch {
      if (this.active) this.ctx.logger.warn('IM AI 待处理消息查询失败')
    } finally {
      this.polling = false
    }
  }
  private async authorize(row: JobRow): Promise<Access> {
    const message = this.requests.get(row.id)
    return message
      ? this.ai.authorize('im', message.request)
      : this.ai.authorizeBackground(this.ctx, 'im', row.actor_id, row.workspace_id)
  }
  private async execute(row: JobRow) {
    const epoch = this.epochs.get(row.workspace_id) ?? 0
    const target = {
      connectionId: row.connection_id,
      chat: { type: row.chat_type, id: row.chat_id },
      workspaceId: row.workspace_id,
    }
    const live = () => {
      this.abort.signal.throwIfAborted()
      if (epoch !== (this.epochs.get(row.workspace_id) ?? 0)) throw new Error('运行已停止')
      const policy = this.ctx.im.getChatPolicy(row.connection_id, target.chat)
      if (!policy.enabled || policy.ai === false) throw new Error('聊天 AI 已禁用')
      return policy
    }
    let access: Access | undefined
    try {
      // 连接尚未上线时保留恢复任务，避免启动顺序导致丢失。
      access = await this.authorize(row)
      const policy = live()
      if (row.status === 'queued' || row.status === 'running') {
        if (!row.command) {
          const agentId = policy.agentId ?? this.ai.defaultAgentId
          if (!agentId) throw new Error('尚未配置 Agent')
          let session = await this.db
            .selectFrom('sessions')
            .selectAll()
            .where('workspace_id', '=', row.workspace_id)
            .executeTakeFirst()
          if (!session || session.agent_id !== agentId) {
            const conversation = await this.ai.createConversation(access, agentId, 'IM 对话')
            live()
            session = {
              workspace_id: row.workspace_id,
              conversation_id: conversation.id,
              agent_id: agentId,
            }
            await this.db.transaction(async (db) => {
              await db.deleteFrom('sessions').where('workspace_id', '=', row.workspace_id).execute()
              await db.insertInto('sessions').values(session!).execute()
            })
          }
          const { conversation } = await this.ai.getConversation(access, session.conversation_id)
          const snapshot = row.snapshot
            ? await refreshAttachments(JSON.parse(row.snapshot) as InputSnapshot, (id) =>
                this.ctx.im.mediaAvailable(row.workspace_id, id),
              )
            : undefined
          if (snapshot) {
            row.snapshot = JSON.stringify(snapshot)
            row.input = renderInput(snapshot)
          }
          const command: RunCommand = {
            operation: 'send',
            expectedRevision: conversation.revision,
            expectedNodeId: conversation.selectedNodeId,
            idempotencyKey: row.id,
            input: {
              text: row.input,
              expandTemplateVariables: false,
              variables: {
                imActorId: row.actor_id,
                imWorkspaceId: row.workspace_id,
                imJobId: row.id,
              },
              ...(snapshot ? { attachments: snapshot.attachments } : {}),
            },
          }
          row.conversation_id = conversation.id
          row.command = JSON.stringify(command)
          await this.db
            .updateTable('jobs')
            .set({
              conversation_id: row.conversation_id,
              command: row.command,
              status: 'running',
              input: row.input,
              snapshot: row.snapshot,
            })
            .where('id', '=', row.id)
            .execute()
        }
        live()
        const run = row.run_id
          ? await this.ai.getRun(access, row.run_id)
          : await this.ai.start(access, row.conversation_id!, JSON.parse(row.command) as RunCommand)
        row.run_id = run.id
        this.activeRuns.set(row.workspace_id, run.id)
        // start 与 run_id 保存之间崩溃时，持久化的原始 command 可使用同一幂等键恢复。
        await this.db
          .updateTable('jobs')
          .set({ run_id: run.id, status: 'running' })
          .where('id', '=', row.id)
          .execute()
        let current = run
        while (current.status === 'running') {
          live()
          await delay(this.config.pollIntervalMs, undefined, { signal: this.abort.signal })
          current = await this.ai.getRun(access, run.id)
        }
        live()
        row.status =
          current.status === 'completed'
            ? 'completed'
            : current.status === 'cancelled'
              ? 'cancelled'
              : 'failed'
        row.answer =
          current.status === 'completed'
            ? finalText(current)
            : current.status === 'cancelled'
              ? null
              : 'AI 运行失败，请使用 /reset 开始新的对话后重试。'
        await this.db
          .updateTable('jobs')
          .set({
            status: row.status,
            answer: row.answer,
            ...(!row.answer ? { delivery: 'sent' as const } : {}),
          })
          .where('id', '=', row.id)
          .execute()
      }
      if (row.answer) {
        live()
        await this.ai.verify(access)
        await this.db
          .updateTable('jobs')
          .set({ attempts: row.attempts + 1 })
          .where('id', '=', row.id)
          .execute()
        try {
          await this.ctx.im.send(target, [{ type: 'text', text: row.answer }], {
            idempotencyKey: `im-ai-${row.id}`,
            signal: this.abort.signal,
          })
          await this.db
            .updateTable('jobs')
            .set({ delivery: 'sent' })
            .where('id', '=', row.id)
            .execute()
        } catch (error) {
          // 未知投递结果不得自动重试，避免平台已送达而本地超时后重复发送。
          const unknown =
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'delivery_unknown' || error.code === 'timeout')
          await this.db
            .updateTable('jobs')
            .set({
              delivery: unknown
                ? 'unknown'
                : row.attempts + 1 >= this.config.deliveryAttempts
                  ? 'failed'
                  : 'pending',
            })
            .where('id', '=', row.id)
            .execute()
        }
      }
    } catch (error) {
      if (row.run_id) await this.ai.running.get(row.run_id)?.cancel()
      if (!this.active) return
      const unavailable =
        !!error && typeof error === 'object' && 'status' in error && error.status === 503
      if (unavailable && !access) return
      let canNotify = false
      if (access) {
        try {
          live()
          await this.ai.verify(access)
          canNotify = true
        } catch {
          /* 已撤销的身份与聊天不再回复。 */
        }
      }
      await this.db
        .updateTable('jobs')
        .set({
          status: 'failed',
          delivery: canNotify ? 'pending' : 'failed',
          answer: canNotify
            ? 'AI 暂时无法处理此消息，请检查 Agent 配置，或使用 /reset 后重试。'
            : null,
        })
        .where('id', '=', row.id)
        .execute()
      this.ctx.logger.warn('IM AI 消息未完成：身份、策略或运行状态不可用')
    } finally {
      this.activeRuns.delete(row.workspace_id)
      this.requests.delete(row.id)
    }
  }
  private async stop(message: MessageContext) {
    await this.ai.authorize('im', message.request)
    this.stopping.add(message.workspaceId)
    try {
      this.epochs.set(message.workspaceId, (this.epochs.get(message.workspaceId) ?? 0) + 1)
      const runId = this.activeRuns.get(message.workspaceId)
      if (runId) await this.ai.running.get(runId)?.cancel()
      await this.workers.get(message.workspaceId)
      await this.db
        .updateTable('jobs')
        .set({ status: 'cancelled', delivery: 'sent' })
        .where('workspace_id', '=', message.workspaceId)
        .where('delivery', '=', 'pending')
        .execute()
    } finally {
      this.stopping.delete(message.workspaceId)
    }
  }
}
