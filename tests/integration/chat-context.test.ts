// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { AiEvent, ContextBudget, ContextOperation, MessageNode } from '@antarestra/contracts'
import { contextRun } from '../fixtures/context-run.js'
import { applyEvent, emptyReply } from '../../plugins/features/chat-webui/client/stream.js'
import { replyContent } from '../../plugins/features/chat-webui/client/reply-content.js'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import ContextMeter from '../../plugins/features/chat-webui/client/ContextMeter.vue'
import ContextSettings from '../../plugins/features/ai-agents/client/ContextSettings.vue'
import { defaultContextPolicy } from '@antarestra/contracts'
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})
const operation: ContextOperation = {
  id: 'op',
  kind: 'compact',
  status: 'running',
  position: 1,
  before: 131000,
  createdAt: 1,
  endedAt: null,
}
const event = (sequence: number, type: AiEvent['type'], data: unknown): AiEvent => ({
  sequence,
  type,
  data: data as AiEvent['data'],
  runId: 'r',
  conversationId: 'c',
  workspaceId: 'w',
  createdAt: 2,
})

it('记忆整理请求保留正在显示的思考和工具过程', () => {
  const state = emptyReply()
  applyEvent(state, event(1, 'message-delta', { kind: 'thinking', text: '正在整理资料' }))
  const pending = structuredClone(state.pending)
  applyEvent(
    state,
    event(2, 'tool-start', {
      type: 'tool-call',
      id: 'memory-call',
      name: 'global_memory',
      arguments: { action: 'append', content: '资料' },
    }),
  )
  const tools = structuredClone(state.tools)
  applyEvent(state, event(3, 'request', { purpose: 'memory' }))
  expect(state.pending).toEqual(pending)
  expect(state.tools).toEqual(tools)
  expect(state.status).toBe('正在整理记忆')
})

it('上下文事件去重，摘要请求不清空回复，实时和历史处理顺序一致', () => {
  const state = emptyReply()
  const message = { role: 'assistant', content: [{ type: 'text', text: '中途说明' }] }
  applyEvent(state, event(1, 'message', message))
  applyEvent(state, event(2, 'context-operation', operation))
  applyEvent(state, event(3, 'request', { purpose: 'compaction' }))
  expect(state.completed).toEqual(message.content)
  expect(state.status).toBe('正在压缩上下文')
  const completed = { ...operation, status: 'completed', after: 3000, endedAt: 2 }
  applyEvent(state, event(4, 'context-operation', completed))
  applyEvent(state, event(4, 'context-operation', completed))
  applyEvent(
    state,
    event(5, 'message', { role: 'assistant', content: [{ type: 'text', text: '正文' }] }),
  )
  expect(state.contextOperations).toHaveLength(1)
  const presentation = replyContent(state.completed, [], state.contextOperations)
  expect(presentation.body).toBe('正文')
  expect(presentation.details.map((detail) => detail.type)).toEqual(['text', 'context'])
  expect(presentation).toEqual(replyContent(state.completed, [], [completed as ContextOperation]))
})

it('服务重启事件将未完成处理改为中断', () => {
  const state = emptyReply()
  applyEvent(state, event(1, 'context-operation', { ...operation }))
  applyEvent(state, event(2, 'run-end', { status: 'interrupted' }))
  expect(state.contextOperations[0]?.status).toBe('interrupted')
})

it('已处理默认折叠，展开可见分割线，复制正文不包含摘要或处理记录', async () => {
  const node = {
    id: 'n',
    createdAt: 0,
    role: 'assistant',
    content: [
      { type: 'text', text: '中途说明' },
      { type: 'text', text: '最终原文' },
    ],
  } as MessageNode
  const run = contextRun({
    status: 'completed',
    messages: [],
    createdAt: 0,
    endedAt: 61000,
    contextOperations: [{ ...operation, status: 'completed', after: 3000, endedAt: 2 }],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(ChatMessage, { node, run }) })
  app.mount(host)
  cleanup.push(() => app.unmount())
  const trigger = host.querySelector<HTMLButtonElement>('.chat-details > button')!
  expect(trigger.textContent).toContain('已处理 1分1秒')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  trigger.click()
  await nextTick()
  await vi.waitFor(() => expect(host.textContent).toContain('已压缩上下文 131K → 3K'))
  expect(host.querySelector('.chat-md')?.textContent ?? host.textContent).toContain('最终原文')
  expect(replyContent(node.content, [], run.contextOperations).body).toBe('最终原文')
})

it('无预算时隐藏环形控件，有预算时可聚焦，清空后重新隐藏', async () => {
  const budget = ref<ContextBudget>()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(ContextMeter, { budget: budget.value, model: '["p","m"]' }),
  })
  app.mount(host)
  cleanup.push(() => app.unmount())
  expect(host.querySelector('button')).toBeNull()
  budget.value = {
    model: { providerId: 'p', modelId: 'm' },
    window: 100000,
    used: 0,
    remaining: 100000,
    reserve: 16000,
    available: 84000,
    phase: 'after',
    source: 'usage',
    createdAt: 0,
  }
  await nextTick()
  const trigger = host.querySelector<HTMLButtonElement>('button')!
  expect(trigger.getAttribute('aria-label')).toBe('查看上下文预算')
  trigger.focus()
  expect(document.activeElement).toBe(trigger)
  expect(host.querySelector('circle[pathLength]')?.getAttribute('stroke-dasharray')).toBe('0 100')
  budget.value = undefined
  await nextTick()
  expect(host.querySelector('button')).toBeNull()
})

it('高级配置继承选项可挂载，保留默认值与关闭时的草稿', async () => {
  const policy = defaultContextPolicy()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () =>
      h(ContextSettings, {
        modelValue: policy,
        capabilities: { providers: [], tools: [], backends: [], skillsAvailable: false },
      }),
  })
  app.mount(host)
  cleanup.push(() => app.unmount())
  await nextTick()
  expect(host.querySelector<HTMLInputElement>('#agent-compression-model')?.value).toBe(
    '与本次主模型相同',
  )
  expect(host.querySelector<HTMLInputElement>('#agent-context-reserve')?.value).toBe('16000')
  expect(host.querySelector<HTMLInputElement>('#agent-context-recent')?.value).toBe('10000')
  expect(host.querySelector('#agent-trim-rounds')).toBeNull()
  const input = host.querySelector<HTMLInputElement>('#agent-context-reserve')!
  input.value = '12.5%'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  expect(policy.compaction.reserve).toBe('12.5%')
})
