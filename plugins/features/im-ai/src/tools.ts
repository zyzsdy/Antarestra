import type { Context } from '@antarestra/plugin-sdk'
import { AiError, type RunContext, type Json } from '@antarestra/ai'
import { ImError } from '@antarestra/im'
import { formatMessage, type InputSnapshot } from './history.js'
import { replyFormatGuide, replyFormatVariable } from './reply.js'

export function registerHistoryTools(
  ctx: Context,
  snapshot: (context: RunContext) => Promise<InputSnapshot | undefined>,
) {
  ctx.ai.registerTool(ctx, {
    id: 'im_recall_message',
    resultMode: 'structured',
    description:
      '撤回当前 IM 聊天中本机器人已发送的消息，适合收回误发或需要更正的回复。message_id 使用聊天上下文、引用消息或 im_history_query 中的原始 messageId，不是 AI 会话消息 ID。只能撤回本机器人在当前聊天的消息，且受平台权限和时限限制。失败或结果未知时不要自动重试。撤回后历史查询仍可能返回该消息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message_id'],
      properties: {
        message_id: {
          type: 'string',
          minLength: 1,
          description: '本机器人在当前聊天已发送消息的原始 messageId，按字符串填写。',
        },
      },
    },
    async execute(args, context) {
      try {
        if (!ctx.ai.running.get(context.runId)?.ownsToolContext(context))
          throw new AiError('forbidden', '撤回消息需要有效工具上下文', 403)
        context.signal.throwIfAborted()
        const target = await ctx.im.resolveTarget(context.workspaceId)
        await ctx.im.invoke(
          target,
          'message.recall',
          { message_id: args.message_id },
          context.signal,
        )
        return { content: { message_id: args.message_id!, recalled: true } }
      } catch (error) {
        if (error instanceof AiError || error instanceof ImError)
          return { content: { error: error.message, code: error.code }, isError: true }
        throw error
      }
    },
  })
  ctx.ai.registerTemplateVariable(ctx, {
    id: 'im_reply_format',
    description: 'IM 分条回复、引用、图片和表情包格式指引；不受自动追加开关影响，非 IM 运行为空。',
    async resolve(context) {
      const input = await snapshot(context)
      return input ? (input.replyFormat?.guide ?? replyFormatGuide()) : ''
    },
  })
  ctx.on('ai/template', async (context, draft) => {
    const input = await snapshot(context)
    if (input?.replyFormat?.append && !replyFormatVariable.test(context.agent.systemTemplate))
      draft.systemPrompt += `\n\n${input.replyFormat.guide}`
  })
  for (const [id, description] of [
    [
      'history_message',
      '上次成功入队激活之后的未读群消息，不包含本次触发消息，受 IM 接入的最大条数限制；媒体使用类型与资源 ID 标签。',
    ],
    ['last_message', '激活本次 IM AI 请求的原始消息；媒体按请求附件上限关联。'],
    ['active_reason', '本次 IM AI 激活原因：被 at、回复或引用、名字或关键词、命令、动态激活等。'],
  ] as const) {
    ctx.ai.registerTemplateVariable(ctx, {
      id,
      description,
      async resolve(context) {
        return (await snapshot(context))?.[id] ?? ''
      },
    })
  }
  ctx.ai.registerTool(ctx, {
    id: 'im_history_query',
    description:
      '查找当前群聊的历史消息，适合补充上下文、定位某人发言或取得要引用、回应、撤回的原始 messageId。已知原始消息 ID 时，用 messageId 精确查找；也可按时间、发送人和文本关键词筛选，同时填写的条件取交集。未找到时返回空列表。结果包含发送者、时间、正文及媒体状态；查看图片时使用可用的资源 ID 调用 workspace_file_read。省略筛选条件读取最近消息；将 nextBeforeSequence 作为 beforeSequence 向更早消息翻页，直到返回空列表。不提供私聊历史。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: {
          type: 'string',
          minLength: 1,
          description:
            '要查找的原始平台消息 ID，使用聊天上下文、引用消息或查询结果中的 messageId，按字符串填写并保留前导零；不是用户 ID、AI 会话消息 ID 或内部归档 ID。',
        },
        startTime: {
          type: 'string',
          format: 'date-time',
          description: '起始时间（含），使用带时区的 ISO 时间，如 2026-10-06T09:00:00+08:00。',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description: '结束时间（含），使用带时区的 ISO 时间，不能早于 startTime。',
        },
        senderId: {
          type: 'string',
          description:
            '发送人的平台用户 ID，使用上下文或查询结果中的 sender.id，不是昵称或消息 ID。',
        },
        keyword: {
          type: 'string',
          maxLength: 1000,
          description: '消息正文需包含的文字，不区分大小写。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: '最多返回的消息条数，默认 50。',
        },
        beforeSequence: {
          type: 'integer',
          minimum: 0,
          description: '上一页的 nextBeforeSequence，原样填写；首次查询省略。',
        },
      },
    },
    async execute(args, context) {
      if (!ctx.ai.running.get(context.runId)?.ownsToolContext(context))
        throw new AiError('forbidden', '群消息查询需要有效工具上下文', 403)
      const parse = (value: unknown) => {
        if (value === undefined) return undefined
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
          throw new AiError('invalid_time', '查询时间格式无效')
        return Date.parse(value)
      }
      const startTime = parse(args.startTime),
        endTime = parse(args.endTime)
      if (startTime !== undefined && endTime !== undefined && startTime > endTime)
        throw new AiError('invalid_time', '开始时间不能晚于结束时间')
      const messages = await ctx.im.history(context.workspaceId, {
        ...(typeof args.messageId === 'string' ? { messageId: args.messageId } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        ...(typeof args.senderId === 'string' ? { senderId: args.senderId } : {}),
        ...(typeof args.keyword === 'string' ? { keyword: args.keyword } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.beforeSequence === 'number' ? { beforeSequence: args.beforeSequence } : {}),
      })
      return {
        messages: messages.map((entry) => ({
          messageId: entry.message.id,
          sender: entry.message.sender,
          timestamp: entry.message.timestamp ?? entry.receivedAt,
          platform: entry.platform,
          connectionId: entry.connectionId,
          chat: entry.message.chat,
          sequence: entry.sequence,
          text: formatMessage(entry.message, entry.media),
          media: entry.media,
        })),
        nextBeforeSequence: messages.length ? messages[0]!.sequence - 1 : null,
      } as unknown as Json
    },
  })
}
