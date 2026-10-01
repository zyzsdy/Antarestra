import { describe, expect, it } from 'vitest'
import type { AiEvent, ChatMessage, RunRecord } from '@antarestra/contracts'
import { applyEvent, emptyReply } from '../../plugins/features/chat-webui/client/stream.js'
import { historyToolDetails } from '../../plugins/features/chat-webui/client/tool-details.js'

const call = { type: 'tool-call' as const, id: 'one', name: 'search', arguments: { query: '晚餐' } }
const result = {
  type: 'tool-result' as const,
  id: 'one',
  content: { error: '工具执行失败' },
  isError: true,
}
const event = (sequence: number, type: AiEvent['type'], data: unknown): AiEvent => ({
  sequence,
  type,
  data: data as AiEvent['data'],
  runId: 'run',
  conversationId: 'conversation',
  workspaceId: 'space',
  createdAt: 1,
})

describe('聊天工具详情', () => {
  it('按调用 ID 配对嵌套的返回事件，实时与历史结果相同且重放不重复', () => {
    const state = emptyReply()
    const messages: ChatMessage[] = [
      { role: 'assistant', content: [call, { ...call, id: 'two' }] },
      { role: 'tool', content: [{ ...result, id: 'two', content: null, isError: false }] },
      { role: 'tool', content: [result] },
    ]
    applyEvent(state, event(1, 'message', messages[0]))
    applyEvent(state, event(2, 'tool-start', call))
    expect(state.tools[0]?.status).toBe('正在执行')
    applyEvent(state, event(3, 'tool-end', messages[1]))
    applyEvent(state, event(4, 'tool-end', messages[2]))
    applyEvent(state, event(4, 'tool-end', messages[2]))
    applyEvent(state, event(5, 'message', messages[2]))
    applyEvent(state, event(6, 'run-end', { status: 'completed', error: null }))
    expect(state.tools).toHaveLength(2)
    expect(state.tools[0]).toMatchObject({
      name: 'search',
      arguments: { query: '晚餐' },
      result: result.content,
      status: '执行失败',
    })
    expect(state.tools[1]).toMatchObject({ result: null, status: '执行完成' })
    expect(state.tools).toEqual(
      historyToolDetails({ messages, status: 'completed', error: null } as RunRecord),
    )
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    '运行 %s 时保留未返回的调用和参数',
    (status) => {
      const state = emptyReply()
      const message: ChatMessage = { role: 'assistant', content: [call] }
      const error =
        status === 'failed' ? { code: 'invalid_request', message: '模型调用了未提供的工具' } : null
      applyEvent(state, event(1, 'message', message))
      applyEvent(state, event(2, 'run-end', { status, error }))
      expect(state.tools[0]?.arguments).toEqual(call.arguments)
      expect(state.tools[0]?.status).not.toBe('执行完成')
      expect(state.tools).toEqual(
        historyToolDetails({ messages: [message], status, error } as RunRecord),
      )
      if (error) expect(state.tools[0]?.result).toEqual({ code: error.code, error: error.message })
    },
  )
})
