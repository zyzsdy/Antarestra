// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import type { MessageNode, RunRecord } from '@antarestra/contracts'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import { formatProcessingTime } from '../../plugins/features/chat-webui/client/processing-time.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  vi.useRealTimers()
})

it.each([
  [-1000, '0秒'],
  [999, '0秒'],
  [59000, '59秒'],
  [60000, '1分0秒'],
  [132000, '2分12秒'],
  [3661000, '1小时1分1秒'],
])('处理时长 %i 毫秒显示为 %s', (duration, expected) => {
  expect(formatProcessingTime(duration)).toBe(expected)
})

it('运行计时、独立思考折叠、终态固定时长和卸载清理', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(132000)
  const run = reactive({ createdAt: 0, endedAt: null, status: 'running' } as RunRecord)
  const node: MessageNode = {
    id: 'reply',
    conversationId: 'conversation',
    parentId: null,
    runId: 'run',
    role: 'assistant',
    createdAt: 0,
    version: 1,
    versionCount: 1,
    content: [
      { type: 'thinking', text: '第一段思考' },
      { type: 'text', text: '中途普通输出' },
      { type: 'thinking', text: '第二段思考' },
      { type: 'text', text: '最终正文' },
    ],
  }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(ChatMessage, { node, run }) })
  app.mount(host)
  let mounted = true
  cleanups.push(() => {
    if (mounted) app.unmount()
  })
  const outer = () => host.querySelector<HTMLButtonElement>('.chat-details > button')!
  expect(outer().textContent).toContain('正在处理 2分12秒')
  const thoughts = host.querySelectorAll<HTMLButtonElement>('.chat-thought > button')
  expect(thoughts).toHaveLength(2)
  expect([...thoughts].every((item) => item.getAttribute('aria-expanded') === 'false')).toBe(true)
  expect(host.querySelector('.chat-detail-text')?.textContent).toContain('中途普通输出')
  thoughts[0]!.click()
  await nextTick()
  await vi.advanceTimersByTimeAsync(20)
  expect(thoughts[0]!.getAttribute('aria-expanded')).toBe('true')
  expect(thoughts[1]!.getAttribute('aria-expanded')).toBe('false')
  expect(host.querySelector('.chat-detail-thinking')?.textContent).toContain('第一段思考')
  await vi.advanceTimersByTimeAsync(1000)
  expect(outer().textContent).toContain('2分13秒')
  run.status = 'completed'
  run.endedAt = 133000
  await nextTick()
  expect(outer().getAttribute('aria-expanded')).toBe('false')
  expect(outer().textContent).toContain('已处理 2分13秒')
  await vi.advanceTimersByTimeAsync(10000)
  expect(outer().textContent).toContain('已处理 2分13秒')
  run.status = 'running'
  run.endedAt = null
  await nextTick()
  app.unmount()
  mounted = false
  expect(vi.getTimerCount()).toBe(0)
})
