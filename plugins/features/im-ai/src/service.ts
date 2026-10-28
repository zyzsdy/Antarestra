import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { AiError, type Access, type RunCommand } from '@antarestra/ai'
import { ImError, type MessageContext, type MessageSegment } from '@antarestra/im'
import '@antarestra/plugin-im-commands'
import { activationReason, finalText, intermediateTexts } from './messages.js'
import { parseReplyWithStatus } from './reply.js'
import {
  prepareInput,
  renderInput,
  defaultInputTemplate,
  refreshAttachments,
  type InputSnapshot,
} from './history.js'
import { registerHistoryTools } from './tools.js'
import { registerInspection } from './inspection.js'
import { registerWakeTasks } from './wake.js'
import { dynamicReplyDefaults } from '@antarestra/im/activation'
import {
  dynamicReplyProbability,
  recordDynamicActivation,
  recordDynamicReply,
} from './dynamic-reply.js'
import type { DynamicReplyState } from './dynamic-reply.js'
import { pluginId } from './store.js'
import type { JobRow, Tables } from './store.js'

export interface Config {
  pollIntervalMs: number
  queueLimit: number
  deliveryAttempts: number
  autoResetUnavailableConversation: boolean
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
  private readonly activeJobs = new Map<string, string>()
  private readonly deliveries = new Map<string, AbortController>()
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
    registerWakeTasks(
      ctx,
      (workspace, operation) => this.serial(workspace, operation),
      () => this.pump(),
      (row) => this.cancelWake(row),
      config.queueLimit,
    )
    registerInspection(ctx, (workspaceId, task) =>
      this.serial(workspaceId, async () => {
        if (this.workers.has(workspaceId))
          throw new ImError(409, 'busy', '请等待该群的 AI 任务和消息投递结束后再永久删除')
        this.stopping.add(workspaceId)
        try {
          await task()
          this.dynamicReplies.delete(workspaceId)
          this.activatedAt.delete(workspaceId)
          this.lastActivatedAt.delete(workspaceId)
        } finally {
          this.stopping.delete(workspaceId)
        }
      }),
    )
    ctx.ai.registerTemplateVariable(ctx, {
      id: 'im_status',
      description: '当前工作空间最近保存的 IM 状态原文；由模型自由书写，无状态时为空。',
      resolve: (context) => this.readStatus(context.workspaceId),
    })
    registerHistoryTools(ctx, async (context, messageId) => {
      const run = this.ai.running.get(context.runId)
      const jobId = run?.inputForContext(context)?.variables?.imJobId
      if (typeof jobId !== 'string') return undefined
      const jobIds = messageId
        ? [
            jobId,
            run!.record.input.variables?.imJobId,
            ...(run!.record.steering ?? [])
              .filter((entry) => entry.position !== null)
              .map((entry) => entry.input.variables?.imJobId),
          ].filter((id): id is string => typeof id === 'string')
        : [jobId]
      const jobs = await this.db
        .selectFrom('jobs')
        .selectAll()
        .where('id', 'in', jobIds)
        .where('workspace_id', '=', context.workspaceId)
        .where('conversation_id', '=', context.conversationId)
        .execute()
      const snapshots = jobs.flatMap((job) =>
        job.snapshot ? [JSON.parse(job.snapshot) as InputSnapshot] : [],
      )
      return messageId
        ? snapshots.find((snapshot) => snapshot.privateMedia?.message.id === messageId)
        : snapshots[0]
    })
    ctx.im.registerHandler(ctx, {
      id: 'im-ai',
      stage: 'ai',
      handle: (message) => this.handle(message),
    })
    ctx.imCommands.registerTrigger(ctx, {
      name: 'ai',
      description: '唤起当前空间 AI',
      usage: '<消息>',
      permission: 'ai.chat.use',
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
  private async readStatus(workspaceId: string) {
    const status = await this.db
      .selectFrom('statuses')
      .select('content')
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst()
    return status?.content ?? ''
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
            beforeSequence: message.archived.sequence - 1,
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
            reply_plan: null,
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
      if (dynamicState) recordDynamicActivation(dynamicState)
      this.activatedAt.set(message.workspaceId, [...times, now])
      this.lastActivatedAt.set(message.workspaceId, now)
      const queued = await this.db
        .selectFrom('jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      await this.steer(queued)
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
          this.active &&
          !this.stopping.has(row.workspace_id) &&
          this.workers.has(row.workspace_id)
        ) {
          await this.serial(row.workspace_id, () => this.steer(row))
          continue
        }
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
  private async steer(row: JobRow) {
    const saved = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirst()
    if (!saved) return false
    Object.assign(row, saved)
    if (row.status !== 'queued' || this.stopping.has(row.workspace_id)) return false
    const policy = this.ctx.im.getChatPolicy(row.connection_id, {
      type: row.chat_type,
      id: row.chat_id,
    })
    if (!this.active || !policy.enabled || policy.ai === false) return false
    const savedCommand = row.command ? (JSON.parse(row.command) as RunCommand) : undefined
    // 定时唤醒仍使用自己的守卫和串行任务；这里只处理普通激活消息。
    if (savedCommand && !savedCommand.activeRunId) return false
    const activeId = savedCommand?.activeRunId ?? this.activeRuns.get(row.workspace_id)
    const live = activeId ? this.ai.running.get(activeId) : undefined
    if (
      !savedCommand &&
      (!live?.record.agent.steeringEnabled ||
        !live.canSteer() ||
        live.record.agent.id !== (policy.agentId ?? this.ai.defaultAgentId))
    )
      return false
    const access = await this.authorize(row)
    let command = savedCommand
    if (!command) {
      const { conversation } = await this.ai.getConversation(access, live!.record.conversationId)
      const snapshot = row.snapshot
        ? await refreshAttachments(JSON.parse(row.snapshot) as InputSnapshot, (id) =>
            this.ctx.im.mediaAvailable(row.workspace_id, id),
          )
        : undefined
      if (snapshot) {
        snapshot.im_status = await this.readStatus(row.workspace_id)
        row.snapshot = JSON.stringify(snapshot)
        row.input = renderInput(snapshot)
      }
      command = {
        operation: 'send',
        activeRunId: activeId!,
        expectedRevision: conversation.revision,
        expectedNodeId: conversation.selectedNodeId,
        idempotencyKey: row.id,
        input: {
          text: row.input,
          expandTemplateVariables: false,
          variables: { imActorId: row.actor_id, imWorkspaceId: row.workspace_id, imJobId: row.id },
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
          input: row.input,
          snapshot: row.snapshot,
        })
        .where('id', '=', row.id)
        .execute()
    }
    try {
      const run = await this.ai.start(access, row.conversation_id!, command)
      // 最终回复由原任务统一投递，引导任务不重复投递同一个 Run 的答案。
      await this.db
        .updateTable('jobs')
        .set({ run_id: run.id, status: 'completed', delivery: 'sent' })
        .where('id', '=', row.id)
        .execute()
      this.requests.delete(row.id)
      return true
    } catch (error) {
      if (!(error instanceof AiError) || !['conflict', 'busy'].includes(error.code)) throw error
      // 运行恰好结束且消息尚未被接收时恢复普通队列，不丢失这次激活。
      await this.db
        .updateTable('jobs')
        .set({ command: null, conversation_id: null })
        .where('id', '=', row.id)
        .execute()
      row.command = null
      row.conversation_id = null
      return false
    }
  }
  private async execute(row: JobRow) {
    if (
      !(await this.db.selectFrom('jobs').select('id').where('id', '=', row.id).executeTakeFirst())
    )
      return
    if (await this.steer(row)) return
    if (row.delivery !== 'pending') return
    this.activeJobs.set(row.workspace_id, row.id)
    const epoch = this.epochs.get(row.workspace_id) ?? 0
    const delivery = new AbortController()
    this.deliveries.set(row.workspace_id, delivery)
    const signal = AbortSignal.any([this.abort.signal, delivery.signal])
    const target = {
      connectionId: row.connection_id,
      chat: { type: row.chat_type, id: row.chat_id },
      workspaceId: row.workspace_id,
    }
    const live = () => {
      signal.throwIfAborted()
      if (epoch !== (this.epochs.get(row.workspace_id) ?? 0)) throw new Error('运行已停止')
      const policy = this.ctx.im.getChatPolicy(row.connection_id, target.chat)
      if (!policy.enabled || policy.ai === false) throw new Error('聊天 AI 已禁用')
      return policy
    }
    let access: Access | undefined
    const backgroundGuard = row.command
      ? (JSON.parse(row.command) as RunCommand).input?.variables?.backgroundTaskGuard
      : undefined
    const verify = async () => {
      await this.ai.verify(access!)
      if (typeof backgroundGuard === 'string' && row.conversation_id)
        await this.ai.verifyBackgroundTask(backgroundGuard, access!, row.conversation_id)
    }
    try {
      // 连接尚未上线时保留恢复任务，避免启动顺序导致丢失。
      access = await this.authorize(row)
      const saved = await this.db
        .selectFrom('jobs')
        .select('status')
        .where('id', '=', row.id)
        .executeTakeFirst()
      if (saved?.status === 'cancelled') return
      await verify()
      const policy = live()
      if (row.status === 'queued' || row.status === 'running') {
        if (backgroundGuard && row.status === 'queued' && row.snapshot && row.command) {
          const snapshot = await refreshAttachments(
            JSON.parse(row.snapshot) as InputSnapshot,
            (id) => this.ctx.im.mediaAvailable(row.workspace_id, id),
          )
          snapshot.im_status = await this.readStatus(row.workspace_id)
          const command = JSON.parse(row.command) as RunCommand
          row.input = renderInput(snapshot)
          command.input = { ...command.input, text: row.input, attachments: snapshot.attachments }
          row.snapshot = JSON.stringify(snapshot)
          row.command = JSON.stringify(command)
          // 开始前固化一次；崩溃恢复时不改写已提交的幂等请求。
          row.status = 'running'
          await this.db
            .updateTable('jobs')
            .set({
              input: row.input,
              snapshot: row.snapshot,
              command: row.command,
              status: row.status,
            })
            .where('id', '=', row.id)
            .execute()
        }
        if (!row.command) {
          const agentId = policy.agentId ?? this.ai.defaultAgentId
          if (!agentId) throw new Error('尚未配置 Agent')
          let session = await this.db
            .selectFrom('sessions')
            .selectAll()
            .where('workspace_id', '=', row.workspace_id)
            .executeTakeFirst()
          if (
            session &&
            session.agent_id === agentId &&
            this.config.autoResetUnavailableConversation
          ) {
            try {
              const state = await this.ai.getConversation(access, session.conversation_id)
              const last = state.path.at(-1)
              const unavailable =
                state.conversation.archivedAt !== null ||
                (!state.conversation.activeRunId &&
                  !!last &&
                  (last.role === 'user' ||
                    (await this.ai.getRun(access, last.runId)).status !== 'completed'))
              if (unavailable) session = undefined
            } catch (error) {
              // 只有已删除的会话可以替换；授权、数据库及配置错误仍交给原处理流程。
              if (!(error instanceof AiError) || error.code !== 'not_found') throw error
              session = undefined
            }
          }
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
            // 在执行而非入队时读取，排队请求才能看到上一轮刚保存的状态。
            snapshot.im_status = await this.readStatus(row.workspace_id)
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
        const forwarded = new Set<string>()
        while (true) {
          live()
          if (current.status !== 'cancelled' && current.status !== 'interrupted') {
            for (const reply of intermediateTexts(current)) {
              if (forwarded.has(reply.id)) continue
              live()
              await verify()
              forwarded.add(reply.id)
              try {
                const { messages } = parseReplyWithStatus(
                  reply.text,
                  this.ctx.im.listConnections().find((item) => item.id === row.connection_id)
                    ?.capabilities,
                )
                // 中间回复也必须整份预检，避免先发送正文后才发现无效引用或资源。
                for (const segments of messages) await this.ctx.im.validateSend(target, segments)
                for (const [index, segments] of messages.entries()) {
                  live()
                  await verify()
                  await this.ctx.im.send(target, segments, {
                    // 首条沿用旧键，恢复任务时避免重复投递已发送的中间回复。
                    idempotencyKey: `im-ai-${row.id}-intermediate-${reply.id}${index ? `-${index}` : ''}`,
                    continuation: index > 0,
                    signal,
                    beforeSend: async () => {
                      live()
                      await verify()
                    },
                  })
                }
              } catch {
                // 中间说明解析或投递失败不终止模型；未知结果由发件箱阻止重复发送。
                this.ctx.logger.warn('IM AI 中间回复无效、未送达或结果未知（任务 %s）', row.id)
              }
            }
          }
          if (current.status !== 'running') break
          await delay(this.config.pollIntervalMs, undefined, { signal })
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
              : (current.error?.code === 'model_output_truncated'
                  ? '模型达到输出上限，回复未完整生成。'
                  : 'AI 运行失败。') +
                (this.config.autoResetUnavailableConversation
                  ? '下次消息将自动开始新的对话，请重新发送需要处理的内容。'
                  : '请使用 /reset 开始新的对话后重试。')
        await this.db
          .updateTable('jobs')
          .set({
            status: row.status,
            answer: row.answer,
            ...(!row.answer && row.status !== 'completed' ? { delivery: 'sent' as const } : {}),
          })
          .where('id', '=', row.id)
          .execute()
      }
      if (row.answer || row.status === 'completed') {
        live()
        await verify()
        if (!row.reply_plan) {
          let messages: MessageSegment[][]
          let status: string | undefined
          try {
            const reply =
              row.status === 'completed'
                ? parseReplyWithStatus(
                    row.answer ?? '',
                    this.ctx.im.listConnections().find((item) => item.id === row.connection_id)
                      ?.capabilities,
                  )
                : { messages: [[{ type: 'text' as const, text: row.answer ?? '' }]] }
            messages = reply.messages
            status = 'status' in reply ? reply.status : undefined
            // 完整预检后才发送第一条；引用必须属于当前空间。
            for (const segments of messages) await this.ctx.im.validateSend(target, segments)
          } catch {
            row.status = 'failed'
            messages = [
              [{ type: 'text', text: 'AI 回复格式、引用或图片地址无效，本次回复未发送，请重试。' }],
            ]
            this.ctx.logger.warn('IM AI 回复预检失败，未发送回复内容')
          }
          live()
          const replyPlan = JSON.stringify(messages)
          // 状态与回复计划一起提交，恢复和投递重试不会重复写入旧状态。
          await this.db.transaction(async (db) => {
            live()
            if (row.status === 'completed' && status !== undefined) {
              await db.deleteFrom('statuses').where('workspace_id', '=', row.workspace_id).execute()
              await db
                .insertInto('statuses')
                .values({ workspace_id: row.workspace_id, content: status })
                .execute()
            }
            await db
              .updateTable('jobs')
              .set({ reply_plan: replyPlan, status: row.status })
              .where('id', '=', row.id)
              .execute()
            live()
          })
          row.reply_plan = replyPlan
          // 只在首次固化有效回复时更新热度，投递重试不再次改变动态状态。
          const dynamic = row.chat_type === 'group' ? live().activation?.dynamic : undefined
          const state = this.dynamicReplies.get(row.workspace_id)
          if (row.status === 'completed' && dynamic && state)
            recordDynamicReply(dynamic, state, Date.now(), messages.length > 0)
        }
        const messages = JSON.parse(row.reply_plan) as MessageSegment[][]
        if (!messages.length) {
          await this.db
            .updateTable('jobs')
            .set({ delivery: 'sent' })
            .where('id', '=', row.id)
            .execute()
          return
        }
        let attemptStarted = false
        try {
          for (const [index, segments] of messages.entries()) {
            live()
            await verify()
            await this.ctx.im.send(target, segments, {
              // 首条沿用旧键，恢复旧任务时也不会重复发送。
              idempotencyKey: `im-ai-${row.id}${index ? `-${index}` : ''}`,
              continuation: index > 0,
              signal,
              beforeSend: async () => {
                live()
                await verify()
                // 等待可被卸载取消，直到实际投递前才记录本轮尝试。
                if (!attemptStarted) {
                  await this.db
                    .updateTable('jobs')
                    .set({ attempts: row.attempts + 1 })
                    .where('id', '=', row.id)
                    .execute()
                  attemptStarted = true
                }
              },
            })
          }
          await this.db
            .updateTable('jobs')
            .set({ delivery: 'sent' })
            .where('id', '=', row.id)
            .execute()
        } catch (error) {
          // 调度器重载或租约尚未恢复不消耗平台投递次数。
          if (backgroundGuard && error instanceof AiError && error.status === 503) return
          // 未知投递结果不得自动重试，避免平台已送达而本地超时后重复发送。
          const unknown =
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            (error.code === 'delivery_unknown' || error.code === 'timeout')
          const interrupted = signal.aborted && !unknown
          await this.db
            .updateTable('jobs')
            .set({
              delivery: unknown
                ? 'unknown'
                : !interrupted && row.attempts + 1 >= this.config.deliveryAttempts
                  ? 'failed'
                  : 'pending',
              // 未开始投递就取消不消耗次数；明确失败仍计数，避免无限重试。
              attempts: row.attempts + (interrupted && !attemptStarted ? 0 : 1),
            })
            .where('id', '=', row.id)
            .execute()
        }
      }
    } catch (error) {
      if (row.run_id) await this.ai.running.get(row.run_id)?.cancel()
      if (!this.active) return
      const saved = await this.db
        .selectFrom('jobs')
        .select('status')
        .where('id', '=', row.id)
        .executeTakeFirst()
      if (saved?.status === 'cancelled') return
      const unavailable =
        !!error && typeof error === 'object' && 'status' in error && error.status === 503
      if (unavailable && (!access || backgroundGuard)) return
      // 已固化的投递内容不可换成另一份答案复用原有幂等键。
      if (row.reply_plan) {
        await this.db
          .updateTable('jobs')
          .set({ delivery: 'failed' })
          .where('id', '=', row.id)
          .execute()
        return
      }
      let canNotify = false
      if (access) {
        try {
          live()
          await verify()
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
            ? this.config.autoResetUnavailableConversation
              ? 'AI 暂时无法处理此消息，请检查 Agent 配置后重试。'
              : 'AI 暂时无法处理此消息，请检查 Agent 配置，或使用 /reset 后重试。'
            : null,
        })
        .where('id', '=', row.id)
        .execute()
      this.ctx.logger.warn(
        'IM AI 消息未完成（任务 %s）：%s',
        row.id,
        error instanceof AiError ? `${error.code}: ${error.message}` : '身份、策略或运行状态不可用',
      )
    } finally {
      this.activeJobs.delete(row.workspace_id)
      if (this.deliveries.get(row.workspace_id) === delivery)
        this.deliveries.delete(row.workspace_id)
      this.activeRuns.delete(row.workspace_id)
      this.requests.delete(row.id)
    }
  }
  private async cancelWake(row: JobRow) {
    const mark = () =>
      this.db
        .updateTable('jobs')
        .set({ status: 'cancelled', delivery: 'sent' })
        .where('id', '=', row.id)
        .where('workspace_id', '=', row.workspace_id)
        .execute()
    await mark()
    if (this.activeJobs.get(row.workspace_id) === row.id) {
      this.deliveries.get(row.workspace_id)?.abort()
      const run = this.activeRuns.get(row.workspace_id)
      if (run) await this.ai.running.get(run)?.cancel()
      await this.workers.get(row.workspace_id)
      await mark()
    }
  }
  private async stop(message: MessageContext) {
    await this.ai.authorize('im', message.request)
    this.stopping.add(message.workspaceId)
    try {
      this.epochs.set(message.workspaceId, (this.epochs.get(message.workspaceId) ?? 0) + 1)
      this.deliveries.get(message.workspaceId)?.abort()
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
