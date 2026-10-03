import type { Context } from '@antarestra/plugin-sdk'
import { AiError, type RunContext, type Json } from '@antarestra/ai'
import { formatMessage, type InputSnapshot } from './history.js'
import { replyFormatGuide, replyFormatVariable } from './reply.js'

export function registerHistoryTools(
  ctx: Context,
  snapshot: (context: RunContext) => Promise<InputSnapshot | undefined>,
) {
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
      '上次成功入队激活之后的未读群消息，受 IM 接入的最大条数限制；媒体使用类型与资源 ID 标签。',
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
      '查询当前工作空间的群聊原始消息。可按时间范围（带时区的 ISO 时间）、发送人平台 ID 和文本关键词筛选。结果包含原始消息 ID，可用于回复或引用；媒体状态标识已存储、待重试或已过期。每页最多 200 条，使用 nextBeforeSequence 向更早消息翻页。私聊不单独归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        startTime: { type: 'string', format: 'date-time' },
        endTime: { type: 'string', format: 'date-time' },
        senderId: { type: 'string' },
        keyword: { type: 'string', maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        beforeSequence: { type: 'integer', minimum: 0 },
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
