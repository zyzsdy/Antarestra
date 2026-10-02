import type {
  AiEvent,
  ChatMessage,
  ContentBlock,
  RunRecord,
  ContextBudget,
  ContextOperation,
} from '@antarestra/contracts'
import { finishToolDetails, mergeToolBlocks, type ToolDetail } from './tool-details.js'

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
  budget?: ContextBudget
  contextOperations: ContextOperation[]
  sequence: number
  completed: ContentBlock[]
  pending: ContentBlock[]
  tools: ToolDetail[]
  status: string
  ended: boolean
}
export const emptyReply = (): ReplyState => ({
  contextOperations: [],
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
    case 'context-budget':
      state.budget = event.data as unknown as ContextBudget
      break
    case 'context-operation': {
      const operation = event.data as unknown as ContextOperation
      const index = state.contextOperations.findIndex((entry) => entry.id === operation.id)
      if (index < 0) state.contextOperations.push(operation)
      else state.contextOperations[index] = operation
      if (operation.status === 'running')
        state.status = operation.kind === 'trim' ? '正在裁剪上下文' : '正在压缩上下文'
      break
    }
    case 'provider-tool': {
      const block = event.data as unknown as Extract<ContentBlock, { type: 'provider-tool' }>
      const existing = [...state.completed, ...state.pending].find(
        (item) => item.type === 'provider-tool' && item.id === block.id,
      )
      if (existing) Object.assign(existing, block)
      else state.pending.push(block)
      mergeToolBlocks(state.tools, [event.data as unknown as ContentBlock])
      state.status = '提供商正在处理工具'
      break
    }
    case 'request':
      if (data.purpose === 'compaction') {
        state.status = '正在压缩上下文'
        break
      }
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
      mergeToolBlocks(state.tools, message.content)
      if (message.role === 'assistant') {
        state.completed.push(...message.content)
        state.pending = []
      }
      break
    }
    case 'tool-start': {
      state.status = '正在执行工具'
      mergeToolBlocks(state.tools, [event.data as unknown as ContentBlock], true)
      break
    }
    case 'tool-end': {
      state.status = '正在思考'
      mergeToolBlocks(state.tools, (event.data as unknown as ChatMessage).content)
      break
    }
    case 'run-end':
      for (const operation of state.contextOperations) {
        if (operation.status === 'running') {
          operation.status =
            data.status === 'cancelled'
              ? 'cancelled'
              : data.status === 'interrupted'
                ? 'interrupted'
                : 'failed'
          operation.endedAt = event.createdAt
        }
      }
      finishToolDetails(
        state.tools,
        data.status as RunRecord['status'],
        (data.error as RunRecord['error']) ?? null,
      )
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
