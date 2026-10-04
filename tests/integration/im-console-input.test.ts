// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { ChatMessage, RequestSnapshot } from '@antarestra/contracts'
import type { AiHistoryDetail } from '@antarestra/im'
import AiHistoryDetailView from '../../plugins/features/im-console/client/AiHistoryDetail.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))

const user = (text: string, id?: string): ChatMessage => ({
  ...(id ? { id } : {}),
  role: 'user',
  content: [{ type: 'text', text }],
})
const current = user('模板渲染阶段的文本', 'current')
function request(messages: ChatMessage[], purpose?: RequestSnapshot['purpose']): RequestSnapshot {
  return {
    ...(purpose ? { purpose } : {}),
    model: { providerId: 'test', modelId: 'model' },
    thinking: null,
    parameters: {},
    systemPrompt: '系统提示词',
    messages,
    tools: [],
  }
}
function detail(requests: RequestSnapshot[]): AiHistoryDetail {
  return {
    id: 'job',
    conversationId: 'conversation',
    runId: 'run',
    status: 'completed',
    delivery: 'sent',
    createdAt: 1000,
    inputPreview: '原始 IM 输入',
    input: '原始 IM 输入',
    hasAnswer: true,
    answer: '回复',
    run: {
      status: 'completed',
      model: { providerId: 'test', modelId: 'model' },
      messages: [current],
      requests,
      error: null,
      endedAt: 2000,
    },
  }
}
function mount(initial: AiHistoryDetail) {
  const value = ref(initial)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(AiHistoryDetailView, { detail: value.value }) })
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return { value, section: host.querySelector('section[aria-label="发送给 AI 的输入"]')! }
}

it('展示首次回复请求处理后的本轮输入和附件，排除原文、旧轮次与辅助请求', () => {
  const actual = user('本次激活原因：关键词\n最近消息：你好\n<script>原样展示</script>', 'current')
  actual.content.push({
    type: 'image',
    resourceId: 'image',
    mimeType: 'image/png',
    filename: '图片.png',
  })
  const { section } = mount(
    detail([
      request([user('压缩请求')], 'compaction'),
      request([user('记忆请求')], 'memory'),
      request([user('上一轮用户输入', 'previous'), actual], 'reply'),
      request([user('后续请求版本', 'current')], 'reply'),
    ]),
  )
  expect(section.textContent).toContain('本次激活原因：关键词\n最近消息：你好')
  expect(section.textContent).toContain('图片.png')
  expect(section.querySelector('script')).toBeNull()
  for (const text of [
    '原始 IM 输入',
    '模板渲染阶段',
    '上一轮用户输入',
    '压缩请求',
    '记忆请求',
    '后续请求版本',
  ])
    expect(section.textContent).not.toContain(text)
})

it('旧快照缺少用途和消息 ID 时，显示最后一条用户消息', () => {
  const { section } = mount(detail([request([user('上一轮'), user('旧版实际输入')])]))
  expect(section.textContent).toContain('旧版实际输入')
  expect(section.textContent).not.toContain('上一轮')
})

it('本轮消息被请求处理移除时，不拿历史用户消息或原始输入冒充', () => {
  const { section } = mount(detail([request([user('上一轮', 'previous')], 'reply')]))
  expect(section.textContent).toContain('回复请求快照中没有本轮用户消息')
  expect(section.querySelector('.im-ai-message')).toBeNull()
  expect(section.textContent).not.toContain('上一轮')
})

it('等待期间不提前显示渲染文本，快照到达后更新实际输入', async () => {
  const initial = detail([request([user('压缩请求')], 'compaction')])
  initial.status = 'running'
  const { value, section } = mount(initial)
  expect(section.textContent).toContain('尚未生成回复请求快照')
  expect(section.textContent).not.toContain('模板渲染阶段')
  value.value = detail([request([user('实际输入已到达', 'current')], 'reply')])
  await nextTick()
  expect(section.textContent).toContain('实际输入已到达')
  expect(section.textContent).not.toContain('尚未生成回复请求快照')
})

it.each(['queued', 'failed', 'missing-run'] as const)(
  '缺少实际请求时保留明确标记的原始输入：%s',
  async (state) => {
    const initial = detail([])
    if (state === 'missing-run') initial.run = null
    else initial.status = state
    const { section } = mount(initial)
    expect(section.textContent).toContain(
      state === 'queued'
        ? '尚未生成回复请求快照'
        : state === 'failed'
          ? '未保存回复请求快照'
          : '运行详情已不存在',
    )
    expect(section.querySelector('.im-ai-message')).toBeNull()
    expect(section.querySelector('button')?.textContent).toBe(
      '查看原始 IM 输入（Agent 模板处理前）',
    )
    section.querySelector<HTMLButtonElement>('button')!.click()
    await expect.poll(() => section.querySelector('pre')?.textContent).toBe('原始 IM 输入')
  },
)
