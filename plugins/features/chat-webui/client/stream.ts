import type { AiEvent, ChatMessage, ContentBlock } from '@antarestra/contracts'

/** 网络块不等于 SSE 帧；只在完整空行边界交付事件。 */
export class EventDecoder<T extends { sequence: number } = AiEvent> {
  private buffer = ''
  push(text: string): T[] {
    this.buffer += text
    const result: T[] = []
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (!match) break
      const frame = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      const event = JSON.parse(data) as T
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
        throw new Error('回复连接中断，请重新连接')
      result.push(event)
    }
    return result
  }
}

export interface ReplyState {
  sequence: number
  completed: ContentBlock[]
  pending: ContentBlock[]
  tools: { id: string; name: string; status: string; detail: string }[]
  status: string
  ended: boolean
}
export const emptyReply = (): ReplyState => ({
  sequence: 0,
  completed: [],
  pending: [],
  tools: [],
  status: '正在思考',
  ended: false,
})

export function applyEvent(state: ReplyState, event: AiEvent) {
  if (event.sequence <= state.sequence) return
  if (event.sequence !== state.sequence + 1) throw new Error('回复事件缺失，请重新连接')
  const data = event.data as Record<string, unknown>
  switch (event.type) {
    case 'request':
      state.pending = []
      state.status = '正在思考'
      break
    case 'message-delta': {
      if ((data.kind === 'text' || data.kind === 'thinking') && typeof data.text === 'string') {
        const last = state.pending.at(-1)
        if (last?.type === data.kind && 'text' in last) last.text += data.text
        else state.pending.push({ type: data.kind, text: data.text })
        state.status = data.kind === 'thinking' ? '正在思考' : '正在回复'
      }
      break
    }
    case 'message': {
      const message = event.data as unknown as ChatMessage
      if (message.role === 'assistant') {
        state.completed.push(...message.content)
        state.pending = []
      }
      break
    }
    case 'tool-start':
    case 'tool-end': {
      state.status = event.type === 'tool-start' ? '正在执行工具' : '正在思考'
      const id = String(data.id ?? event.sequence)
      const tool = state.tools.find((item) => item.id === id)
      const status =
        event.type === 'tool-start' ? '正在执行' : data.isError ? '执行失败' : '执行完成'
      if (tool) {
        tool.status = status
        tool.detail += '\n' + JSON.stringify(event.data, null, 2)
      } else
        state.tools.push({
          id,
          name: String(data.name ?? data.id ?? '工具'),
          status,
          detail: JSON.stringify(event.data, null, 2),
        })
      break
    }
    case 'run-end':
      state.ended = true
      state.status = ''
      break
  }
  state.sequence = event.sequence
}

export async function readEvents<T extends { sequence: number } = AiEvent>(
  response: Response,
  onEvent: (event: T) => void,
  signal: AbortSignal,
) {
  if (!response.ok || !response.body) throw new Error('暂时无法连接回复流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = new EventDecoder<T>()
  const abort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      for (const event of events.push(decoder.decode(chunk.value, { stream: true }))) onEvent(event)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
