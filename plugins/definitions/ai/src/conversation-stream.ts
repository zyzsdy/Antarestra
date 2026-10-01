import { Readable } from 'node:stream'
import type { Context } from '@antarestra/plugin-sdk'
import type { HttpContext } from '@antarestra/plugin-server'
import type { Conversation, ConversationStateEvent } from '@antarestra/contracts'
import type { Access } from './index.js'

export function conversationStream(ctx: Context, http: HttpContext, access: Access) {
  const controller = new AbortController()
  const pending = new Map<string, { conversation: Readonly<Conversation>; deleted: boolean }>()
  let wake: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sequence = 0
  const off = ctx.on('ai/conversation', (conversation, deleted = false) => {
    if (conversation.workspaceId !== access.workspaceId || controller.signal.aborted) return
    const previous = pending.get(conversation.id)
    if (!previous || previous.conversation.revision <= conversation.revision)
      pending.set(conversation.id, { conversation, deleted })
    // 慢客户端只缓存最新摘要；超过上限断开，重连通过快照恢复。
    if (pending.size > 1000) controller.abort()
    wake?.()
  })
  const release = ctx.effect(() => () => {
    controller.abort()
    off()
    if (timer) clearTimeout(timer)
    wake?.()
    pending.clear()
  })
  const close = () => void release()
  http.res.once('close', close)
  const frame = (event: ConversationStateEvent) =>
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  http.type = 'text/event-stream'
  http.set('X-Accel-Buffering', 'no')
  http.body = Readable.from(
    (async function* () {
      try {
        // 先订阅，再要求校准快照，覆盖列表读取和订阅之间的状态变化。
        yield frame({ sequence: ++sequence, type: 'ready' })
        while (!controller.signal.aborted) {
          if (!pending.size) {
            await new Promise<void>((resolve) => {
              wake = resolve
              timer = setTimeout(resolve, 15_000)
            })
            if (timer) clearTimeout(timer)
            timer = undefined
            wake = undefined
          }
          if (controller.signal.aborted) break
          // 长连接不能沿用已撤销的权限或过期身份。
          await ctx.ai.verify(access)
          const updates = [...pending.values()]
          pending.clear()
          if (!updates.length) yield ': heartbeat\n\n'
          for (const { conversation, deleted } of updates) {
            if (controller.signal.aborted) break
            yield frame(
              deleted
                ? {
                    sequence: ++sequence,
                    type: 'deleted',
                    conversationId: conversation.id,
                    workspaceId: conversation.workspaceId,
                  }
                : { sequence: ++sequence, type: 'conversation', conversation },
            )
          }
        }
      } finally {
        http.res.off('close', close)
        await release()
      }
    })(),
    { highWaterMark: 1, objectMode: false },
  )
}
