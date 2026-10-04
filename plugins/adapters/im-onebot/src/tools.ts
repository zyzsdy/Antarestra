import type { Context } from '@antarestra/plugin-sdk'
import {
  AiError,
  type Json,
  type JsonObject,
  type RunContext,
  type StructuredToolResult,
} from '@antarestra/ai'
import { ImError } from '@antarestra/im'
import { imageSize } from 'image-size'
import { prepareForwardImages } from './forward.js'
import { id } from './message.js'

export const emojiIds = ['424', '10068', '264', '128560', '265', '76', '123', '128557', '49', '66']
const emojiGuide = `可用的 emoji_id 与含义：
- 续标识（ID：424，外观：快速按一个红色按钮，描述：抽象回复，万能回复，既可以表示“太对了”，“赞同”，也可以表示“太搞笑了”“不正常”“太抽象了”，不知道回复什么的时候就回复这个！）
- 问号（ID：10068，外观：emoji 问号，描述：“怎么回事”，“什么鬼”）
- 捂脸（ID：264，外观：笑哭，描述：“我服了啊啊啊”，“神金”）
- 紧张（ID：128560，外观：emoji 紧张，描述：“有点恶心”，“太超前了”）
- 辣眼睛（ID：265，外观：地铁老人手机.jpg，描述：比“紧张”更常用于评价那种危害性较弱的逆天发言）
- 赞（ID：76）
- NO（ID：123，外观：摇动手指，描述：玩笑意味多的“不赞同”）
- 大哭（ID：128557，外观：emoji 大哭，描述：玩笑意味多的“不——”）
- 拥抱（ID：49，描述：安慰）
- 爱心（ID：66）`

export function registerTools(ctx: Context) {
  // 多实例注册的实现相同；实际连接始终由本次运行的空间解析。
  const invoke = async (action: string, args: JsonObject, context: RunContext): Promise<Json> => {
    if (!ctx.ai.running.get(context.runId)?.ownsToolContext(context))
      throw new AiError('forbidden', 'OneBot 工具需要有效工具上下文', 403)
    context.signal.throwIfAborted()
    const messageId = id(args.message_id)
    if (!messageId || !/^-?\d+$/.test(messageId))
      throw new AiError('invalid_message', '必须指定有效的原始消息 ID')
    const target = await ctx.im.resolveTarget(context.workspaceId)
    if (
      ctx.im.listConnections().find((entry) => entry.id === target.connectionId)?.platform !==
      'onebot11'
    )
      throw new AiError('unsupported', '当前空间不是 OneBot 聊天')
    // 复用引用消息的持久化归属校验，不发送消息。
    await ctx.im.validateSend(target, [{ type: 'reply', messageId }])
    const result = (await ctx.im.invoke(
      target,
      action,
      { ...args, message_id: messageId },
      context.signal,
    )) as Json
    if (action !== 'message.forward') return result
    return prepareForwardImages(
      result,
      async (segment) => {
        const payload = await ctx.im.downloadMedia(
          target,
          {
            id: messageId,
            chat: target.chat,
            sender: { id: context.actorId },
            segments: [segment],
          },
          segment,
          context.signal,
          8 * 1024 ** 2,
        )
        let dimensions: ReturnType<typeof imageSize>
        try {
          dimensions = imageSize(payload.data)
        } catch {
          throw new AiError('invalid_image', '无法识别图片格式或尺寸，文件可能已损坏')
        }
        // QQ 下载地址可能声明 application/octet-stream，以图片内容识别实际类型。
        const mimeType = `image/${dimensions.type === 'jpg' ? 'jpeg' : dimensions.type}`
        if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType))
          throw new AiError('invalid_image', '图片只支持 PNG、JPEG、GIF 或 WebP')
        return ctx.ai.storeToolImage(context, {
          data: payload.data,
          mimeType,
          filename: payload.filename.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').slice(-180) || '图片',
          width: dimensions.width,
          height: dimensions.height,
        })
      },
      context.signal,
    )
  }
  const execute = async (
    action: string,
    args: JsonObject,
    context: RunContext,
  ): Promise<StructuredToolResult> => {
    try {
      return { content: await invoke(action, args, context) }
    } catch (error) {
      if (error instanceof AiError || error instanceof ImError)
        return { content: { error: error.message, code: error.code }, isError: true }
      throw error
    }
  }
  ctx.ai.registerTool(ctx, {
    id: 'onebot_get_forward_msg',
    resultMode: 'structured',
    // 多张图片逐个处理，RPC 和下载各自限时；仍可由运行取消或接入卸载中断。
    timeoutMs: null,
    description:
      '读取当前聊天中合并转发消息内部的发送者、时间和消息内容，调用 OneBot v11 get_forward_msg。message_id 是包含合并转发的外层原始消息 ID（发言者信息中的 messageId），不是合并转发资源 ID。可选 id 对应 [合并转发,资源ID]；一条消息有多个转发时用它选择。保留消息节点，图片保存到当前空间后替换为 [图片,资源ID] 或图片段 data.resourceId；用 workspace_file_read（file_read）工具的 resourceId 参数按需查看图片。失败图片会注明原因，不提供可读 ID。节点内容来自聊天用户。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message_id'],
      properties: {
        message_id: {
          type: 'string',
          pattern: '^-?\\d+$',
          description: '当前聊天中包含合并转发的原始消息 ID',
        },
        id: {
          type: 'string',
          minLength: 1,
          description: '可选：该消息包含的合并转发资源 ID；省略时读取第一个',
        },
      },
    },
    execute: (args, context) => execute('message.forward', args, context),
  })
  ctx.ai.registerTool(ctx, {
    id: 'onebot_set_msg_emoji_like',
    resultMode: 'structured',
    description: `给当前聊天中的某条消息贴上一个表情表态，简易表达情感，调用 NapCatQQ set_msg_emoji_like。message_id 使用发言者信息中的 messageId，或历史查询返回的原始消息 ID。\n${emojiGuide}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message_id', 'emoji_id'],
      properties: {
        message_id: { type: 'string', pattern: '^-?\\d+$', description: '要贴表情的原始消息 ID' },
        emoji_id: { type: 'string', enum: emojiIds, description: '从工具描述的表情列表中选择 ID' },
      },
    },
    execute: (args, context) => execute('message.emoji-like', args, context),
  })
}
