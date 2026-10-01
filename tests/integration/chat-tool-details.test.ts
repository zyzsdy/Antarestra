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

it('提供商内置工具状态去重、图片预览与取消后的历史保持一致', () => {
  const state = emptyReply()
  const started = {
    type: 'provider-tool' as const,
    id: 'hosted',
    name: 'web_search',
    status: 'in_progress',
    result: { type: 'web_search_call', action: { query: '测试' } },
  }
  applyEvent(state, event(1, 'provider-tool', started))
  expect(state.tools[0]).toMatchObject({ status: '正在执行' })
  expect(state.tools[0]?.result).toBeUndefined()
  applyEvent(state, event(2, 'run-end', { status: 'cancelled', error: null }))
  expect(state.tools[0]?.status).toBe('已取消')
  expect(state.tools).toEqual(
    historyToolDetails({
      messages: [{ role: 'assistant', content: [started] }],
      status: 'cancelled',
      error: null,
    }),
  )
  const completed = {
    ...started,
    name: 'draw',
    status: 'completed',
    result: { type: 'image_generation_call', result: 'aW1hZ2U=', output_format: 'webp' },
  }
  const image = emptyReply()
  applyEvent(image, event(1, 'provider-tool', completed))
  applyEvent(image, event(2, 'message', { role: 'assistant', content: [completed] }))
  expect(image.tools).toHaveLength(1)
  expect(image.tools[0]?.image).toBe('data:image/webp;base64,aW1hZ2U=')
  expect(image.tools[0]?.result).toMatchObject({ result: '[图片内容见预览]' })
})
