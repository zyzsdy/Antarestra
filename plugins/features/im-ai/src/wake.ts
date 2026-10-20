import type { Context } from '@antarestra/plugin-sdk'
import { AiError } from '@antarestra/ai'
import type { Access, BackgroundTaskState, RunCommand } from '@antarestra/ai'
import { defaultInputTemplate, prepareInput, renderInput } from './history.js'
import { pluginId } from './store.js'
import type { JobRow, Tables } from './store.js'

/** 复用 IM 队列的运行、状态保存、回复预检、发送节奏与幂等投递。 */
export function registerWakeTasks(
  ctx: Context,
  serial: <T>(workspace: string, operation: () => Promise<T>) => Promise<T>,
  pump: () => Promise<void>,
  cancel: (row: JobRow) => Promise<void>,
  queueLimit: number,
) {
  const db = ctx.database.scope<Tables>(ctx, pluginId)
  const jobId = (id: string) => `wake:${id}`
  const find = (access: Access, id: string) =>
    db
      .selectFrom('jobs')
      .selectAll()
      .where('id', '=', jobId(id))
      .where('workspace_id', '=', access.workspaceId)
      .where('actor_id', '=', access.actorId)
      .executeTakeFirst()
  ctx.ai.registerBackgroundTaskHandler(ctx, 'im', {
    async enqueue(access, request, signal) {
      await ctx.ai.verify(access)
      await serial(access.workspaceId, async () => {
        signal.throwIfAborted()
        if (await find(access, request.conversationId)) return
        const source = await db
          .selectFrom('jobs')
          .selectAll()
          .where('workspace_id', '=', access.workspaceId)
          .where('actor_id', '=', access.actorId)
          .where('conversation_id', '=', request.sourceConversationId)
          .executeTakeFirst()
        if (!source) throw new AiError('forbidden', '找不到当前身份在来源空间的 IM 会话', 403)
        const target = await ctx.im.resolveTarget(access.workspaceId)
        if (
          source.connection_id !== target.connectionId ||
          source.chat_type !== target.chat.type ||
          source.chat_id !== target.chat.id
        )
          throw new AiError('forbidden', '来源 IM 聊天与空间路由不一致', 403)
        const policy = ctx.im.getChatPolicy(target.connectionId, target.chat)
        if (!policy.enabled || policy.ai === false)
          throw new AiError('forbidden', '来源 IM 聊天的 AI 已禁用', 403)
        const waiting = await db
          .selectFrom('jobs')
          .select('id')
          .where('workspace_id', '=', access.workspaceId)
          .where('status', '=', 'queued')
          .limit(Math.min(100, Math.max(1, policy.queueLimit ?? queueLimit)))
          .execute()
        if (waiting.length >= Math.min(100, Math.max(1, policy.queueLimit ?? queueLimit)))
          throw new AiError('capability_unavailable', '来源 IM 等待队列已满，将稍后重试', 503)
        const connection = ctx.im.listConnections().find((item) => item.id === target.connectionId)
        if (!connection) throw new AiError('capability_unavailable', '来源 IM 接入暂不可用', 503)
        const catalog = await ctx.ai.catalog(access)
        const agent = catalog.agents.find((item) => item.id === request.agentId)
        if (!agent) throw new AiError('capability_unavailable', '原助理暂不可用', 503)
        const model = catalog.providers
          .find((item) => item.id === agent.defaultModel.providerId)
          ?.models.find((item) => item.id === agent.defaultModel.modelId)
        const template = policy.userInputTemplate ?? defaultInputTemplate(target.chat.type)
        const usage = `${agent.systemTemplate}\n${agent.userTemplate.replace(/\{\{\s*input\s*\}\}/g, () => template)}`
        // 定时激活不消耗普通聊天的未读游标，也不伪造或归档平台来信。
        const history =
          target.chat.type === 'group'
            ? await ctx.im.history(access.workspaceId, { limit: policy.historyLimit ?? 50 })
            : []
        const snapshot = prepareInput(
          {
            connection,
            message: {
              id: jobId(request.conversationId),
              chat: target.chat,
              sender: { id: 'scheduled-task', name: '定时任务' },
              timestamp: Date.now(),
              segments: [{ type: 'text', text: request.prompt }],
            },
          },
          history,
          policy,
          `定时唤醒：${request.reason}`,
          usage,
          model?.input,
        )
        snapshot.last_message = `本次为定时激活唤醒，计划任务创建时的信息为：\n${request.prompt}\n请按照此消息进行定时任务的执行。`
        snapshot.wakePrompt = request.prompt
        snapshot.im_status =
          (
            await db
              .selectFrom('statuses')
              .select('content')
              .where('workspace_id', '=', access.workspaceId)
              .executeTakeFirst()
          )?.content ?? ''
        await ctx.ai.createConversation(
          access,
          request.agentId,
          `定时任务：${request.reason}`.slice(0, 200),
          request.conversationId,
        )
        const input = renderInput(snapshot)
        const command: RunCommand = {
          operation: 'send',
          expectedRevision: 0,
          expectedNodeId: null,
          idempotencyKey: request.conversationId,
          input: {
            text: input,
            expandTemplateVariables: false,
            attachments: snapshot.attachments,
            variables: {
              backgroundTaskGuard: 'wake-tasks',
              imActorId: access.actorId,
              imWorkspaceId: access.workspaceId,
              imJobId: jobId(request.conversationId),
            },
          },
        }
        await db.transaction(async (tx) => {
          signal.throwIfAborted()
          await tx
            .insertInto('jobs')
            .values({
              id: jobId(request.conversationId),
              workspace_id: access.workspaceId,
              actor_id: access.actorId,
              connection_id: target.connectionId,
              chat_type: target.chat.type,
              chat_id: target.chat.id,
              input,
              snapshot: JSON.stringify(snapshot),
              conversation_id: request.conversationId,
              command: JSON.stringify(command),
              run_id: null,
              status: 'queued',
              answer: null,
              reply_plan: null,
              delivery: 'pending',
              attempts: 0,
              created_at: Date.now(),
            })
            .execute()
          signal.throwIfAborted()
        })
      })
      void pump()
    },
    async inspect(access, id): Promise<BackgroundTaskState> {
      await ctx.ai.verify(access)
      const row = await find(access, id)
      if (!row) throw new AiError('task_not_found', 'IM 唤醒任务不存在', 404)
      const error =
        row.delivery === 'unknown'
          ? 'IM 投递结果未知，为避免重复发送已停止重试'
          : row.delivery === 'failed'
            ? 'IM 消息投递失败'
            : row.status === 'failed'
              ? 'IM AI 运行失败，请查看执行会话'
              : null
      return {
        status:
          row.delivery === 'pending'
            ? 'running'
            : error
              ? 'failed'
              : row.status === 'cancelled'
                ? 'cancelled'
                : 'completed',
        runId: row.run_id,
        error,
      }
    },
    async cancel(access, id) {
      // 调度器持有的可信身份用于定向回收；身份撤销后仍须停止排队或投递。
      const row = await find(access, id)
      if (row?.delivery === 'pending') await cancel(row)
    },
  })
}
