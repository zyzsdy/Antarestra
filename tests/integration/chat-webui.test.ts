import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiEvent, RunCommand } from '@antarestra/ai'
import {
  applyEvent,
  emptyReply,
  EventDecoder,
  readEvents,
} from '../../plugins/features/chat-webui/client/stream.js'

function event(sequence: number, type: AiEvent['type'], data: AiEvent['data']): AiEvent {
  return {
    runId: 'run',
    conversationId: 'conversation',
    workspaceId: 'space',
    createdAt: 1,
    sequence,
    type,
    data,
  }
}
describe('聊天事件流', () => {
  it('处理任意网络分片、多行 data 和 CRLF，不丢失中文字符', async () => {
    const source = `: heartbeat\r\n\r\nid: 1\r\nevent: message-delta\r\ndata: ${JSON.stringify(event(1, 'message-delta', { kind: 'text', text: '你好🌍' }))}\r\n\r\n`
    const bytes = new TextEncoder().encode(source)
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        },
      }),
    )
    const found: AiEvent[] = []
    await readEvents(response, (item) => found.push(item), new AbortController().signal)
    expect(found).toEqual([event(1, 'message-delta', { kind: 'text', text: '你好🌍' })])
    const decoder = new EventDecoder()
    expect(decoder.push('data: {"sequence":\ndata: 2}\n\n')).toEqual([{ sequence: 2 }])
  })
  it('最终消息替换当前增量，多次模型请求保留此前内容并去重', () => {
    const reply = emptyReply()
    applyEvent(reply, event(1, 'message-delta', { kind: 'text', text: '第一次' }))
    applyEvent(reply, event(1, 'message-delta', { kind: 'text', text: '第一次' }))
    applyEvent(
      reply,
      event(2, 'message', { role: 'assistant', content: [{ type: 'text', text: '第一次完整' }] }),
    )
    applyEvent(reply, event(3, 'request', {}))
    applyEvent(reply, event(4, 'message-delta', { kind: 'thinking', text: '思考' }))
    applyEvent(reply, event(5, 'message-delta', { kind: 'text', text: '第二次' }))
    expect(reply.completed).toEqual([{ type: 'text', text: '第一次完整' }])
    expect(reply.pending).toHaveLength(2)
    applyEvent(
      reply,
      event(6, 'message', { role: 'assistant', content: [{ type: 'text', text: '第二次完整' }] }),
    )
    expect(reply.pending).toEqual([])
    expect(reply.completed).toHaveLength(2)
    applyEvent(reply, event(7, 'run-end', { status: 'completed' }))
    expect(reply.ended).toBe(true)
    expect(() => applyEvent(reply, event(9, 'request', {}))).toThrow('事件缺失')
  })
})

const harness = vi.hoisted(() => ({ api: vi.fn(), cleanups: [] as (() => void)[] }))
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onUnmounted: (fn: () => void) => harness.cleanups.push(fn),
}))
vi.mock('@antarestra/webui/api', async () => {
  const { ref } = await import('vue')
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  }
  const currentRoute = ref({ path: '/', query: {} as Record<string, string> })
  return {
    ApiError,
    useApi: () => ({
      api: harness.api,
      router: {
        currentRoute,
        push: async (value: typeof currentRoute.value) => {
          currentRoute.value = value
        },
      },
    }),
  }
})
import { effectScope, nextTick, watch } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { modelKey, useChat } from '../../plugins/features/chat-webui/client/useChat.js'

const scope = () => effectScope()
let cleanup = () => {}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
  harness.cleanups.splice(0).forEach((fn) => fn())
  vi.restoreAllMocks()
  harness.api.mockReset()
})
const tick = async () => {
  for (let i = 0; i < 10; i++) await nextTick()
}
const model = { providerId: 'p', modelId: 'm' }
const catalog = {
  defaultAgentId: 'agent',
  agents: [
    {
      id: 'agent',
      title: '助理',
      models: [model, { providerId: 'p', modelId: 'plain' }],
      defaultModel: model,
      defaultThinking: 'high',
    },
  ],
  providers: [
    {
      id: 'p',
      title: '提供商',
      models: [
        { id: 'm', title: '模型', thinkingLevels: ['low', 'high'] },
        { id: 'plain', title: '普通模型', thinkingLevels: [] },
      ],
    },
  ],
}
const history = (id: string) => ({
  conversation: {
    id,
    agentId: 'agent',
    revision: 0,
    selectedNodeId: null,
    activeRunId: null,
    archivedAt: null,
  },
  nodes: [],
  path: [],
})
async function mount() {
  const router = useApi().router
  await router.push({ path: '/', query: {} })
  const effect = scope()
  const chat = effect.run(() =>
    useChat(() => ({
      actorId: 'a',
      workspaceId: 'w',
      displayName: '测试',
      roles: [],
      accountPath: '/auth/user/',
    })),
  )!
  cleanup = () => effect.stop()
  await tick()
  return chat
}
describe('聊天会话状态', () => {
  it('断线后携带事件游标重连，结束时原地保存内容而不重载历史', async () => {
    vi.useFakeTimers()
    let completed = false
    const activeHistory = () => ({
      ...history('one'),
      conversation: { ...history('one').conversation, activeRunId: completed ? null : 'run' },
      path: [
        {
          id: 'reply',
          role: 'assistant',
          runId: 'run',
          content: completed ? [{ type: 'text', text: '最终回复' }] : [],
        },
      ],
    })
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? []
          : path.includes('/runs/')
            ? {
                id: 'run',
                replyNodeId: 'reply',
                model,
                thinking: 'high',
                status: completed ? 'completed' : 'running',
              }
            : activeHistory(),
    )
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(
            `data: ${JSON.stringify(event(1, 'message-delta', { kind: 'text', text: '开始' }))}\n\n`,
          ),
      )
      .mockImplementationOnce(async () => {
        completed = true
        return new Response(
          `data: ${JSON.stringify(event(2, 'message', { role: 'assistant', content: [{ type: 'text', text: '最终回复' }] }))}\n\ndata: ${JSON.stringify(event(3, 'run-end', { status: 'completed' }))}\n\n`,
        )
      })
    vi.stubGlobal('fetch', fetcher)
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    await vi.advanceTimersByTimeAsync(500)
    await tick()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/ai/runs/run/events?after=0',
      '/api/ai/runs/run/events?after=1',
    ])
    expect(chat.activeRunId.value).toBeNull()
    expect(chat.detail.value?.path[0]?.content).toEqual([{ type: 'text', text: '最终回复' }])
    expect(
      harness.api.mock.calls.filter(([path]) => path === '/ai/conversations/one'),
    ).toHaveLength(1)
  })
  it.each(['completed', 'failed', 'cancelled'] as const)(
    '新对话发送及 %s 终态不加载历史或列表，保留消息并支持下一轮',
    async (status) => {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  source = controller
                },
              }),
            ),
        ),
      )
      let count = 0
      harness.api.mockImplementation(async (path: string, body?: RunCommand) => {
        if (path === '/ai/catalog') return catalog
        if (path.includes('?')) return []
        if (path === '/ai/conversations')
          return {
            ...history('one').conversation,
            title: '问题',
            createdAt: 1,
            lastActivityAt: 1,
          }
        if (path.endsWith('/runs')) {
          count++
          return {
            id: `run-${count}`,
            conversationId: 'one',
            userNodeId: body?.operation === 'regenerate' ? 'user-1' : `user-${count}`,
            replyNodeId: `reply-${count}`,
            status: 'running',
            model,
            thinking: 'high',
            input: body!.input ?? { text: '问题' },
            messages: [],
            requests: [],
            error: null,
            createdAt: count + 1,
          }
        }
        if (path.endsWith('/cancel')) return {}
        throw new Error(`不应发出请求：${path}`)
      })
      const chat = await mount()
      const loading: boolean[] = []
      const listing: boolean[] = []
      const unwatch = watch(chat.loading, (value) => loading.push(value), { flush: 'sync' })
      const unlist = watch(chat.listing, (value) => listing.push(value), { flush: 'sync' })
      const initialCalls = harness.api.mock.calls.length
      chat.draft.value = '问题'
      await chat.send()
      await tick()
      const user = chat.detail.value!.path[0]
      expect(chat.detail.value?.path.map((node) => node.id)).toEqual(['user-1', 'reply-1'])
      expect(chat.activeRunId.value).toBe('run-1')
      expect(chat.draft.value).toBe('')
      if (status === 'cancelled') {
        await chat.stop()
        expect(chat.activeRunId.value).toBe('run-1')
        expect(chat.detail.value?.path[0]).toBe(user)
      }
      const push = (item: AiEvent) =>
        source!.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ ...item, runId: 'run-1', conversationId: 'one' })}\n\n`,
          ),
        )
      push(event(1, 'message-delta', { kind: 'text', text: '保留回复' }))
      await tick()
      push(
        event(2, 'run-end', {
          status,
          error: status === 'failed' ? { code: 'test', message: '测试错误' } : null,
        }),
      )
      source!.close()
      await tick()
      expect(chat.activeRunId.value).toBeNull()
      expect(chat.detail.value?.path[0]).toBe(user)
      expect(chat.detail.value?.path[1]?.content).toEqual([{ type: 'text', text: '保留回复' }])
      expect(chat.replies.get('run-1')?.ended).toBe(true)
      expect(chat.runs.get('run-1')?.status).toBe(status)
      expect(chat.interrupted.value).toBe(status !== 'completed')
      expect(chat.detail.value?.conversation.revision).toBe(2)
      expect(harness.api.mock.calls.slice(initialCalls).map(([path]) => path)).toEqual([
        '/ai/conversations',
        '/ai/conversations/one/runs',
        ...(status === 'cancelled' ? ['/ai/runs/run-1/cancel'] : []),
      ])
      if (status === 'completed') {
        chat.draft.value = '继续'
        await chat.send()
        expect(harness.api.mock.calls.at(-1)?.[1]).toMatchObject({
          expectedRevision: 2,
          expectedNodeId: 'reply-1',
          input: { text: '继续' },
        })
        expect(chat.detail.value?.path).toHaveLength(4)
        expect(chat.detail.value?.path[0]).toBe(user)
      } else {
        await chat.send(true)
        expect(harness.api.mock.calls.at(-1)?.[1]).toMatchObject({
          operation: 'regenerate',
          expectedRevision: 2,
          targetNodeId: 'reply-1',
        })
        expect(chat.detail.value?.path.map((node) => node.id)).toEqual(['user-1', 'reply-2'])
        expect(chat.detail.value?.path[0]).toBe(user)
      }
      expect(loading).toEqual([])
      expect(listing).toEqual([])
      unwatch()
      unlist()
      source?.close()
    },
  )
  it('中断后回到上一完整节点并恢复原输入，不删除历史节点', async () => {
    let selected = 'reply'
    const nodes = [
      { id: 'user', role: 'user', runId: 'run', parentId: 'previous', content: [] },
      { id: 'reply', role: 'assistant', runId: 'run', parentId: 'user', content: [] },
    ]
    harness.api.mockImplementation(async (path: string, body?: { nodeId?: string }) => {
      if (path === '/ai/catalog') return catalog
      if (path.includes('?')) return []
      if (path.endsWith('/selection')) {
        selected = body!.nodeId!
        return {}
      }
      if (path.includes('/runs/'))
        return {
          id: 'run',
          model,
          thinking: 'high',
          status: 'cancelled',
          userNodeId: 'user',
          input: { text: '原始问题' },
        }
      return {
        ...history('one'),
        conversation: { ...history('one').conversation, selectedNodeId: selected },
        nodes,
        path: selected === 'reply' ? nodes : [],
      }
    })
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    expect(chat.interrupted.value).toBe(true)
    await chat.continuePrevious()
    expect(chat.draft.value).toBe('原始问题')
    expect(chat.detail.value?.nodes).toHaveLength(2)
    expect(
      harness.api.mock.calls.find(([path]) => String(path).endsWith('/selection'))?.[1],
    ).toMatchObject({ expectedNodeId: 'reply', nodeId: 'previous' })
  })
  it('模型分组和推理档位切换，切换会话保留独立草稿', async () => {
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog' ? catalog : path.includes('?') ? [] : history(path.split('/').at(-1)!),
    )
    const chat = await mount()
    expect(chat.thinking.value).toBe('high')
    expect(chat.modelOptions.value[0]?.group).toBe('提供商')
    chat.selectedModel.value = modelKey({ providerId: 'p', modelId: 'plain' })
    expect(chat.thinking.value).toBeNull()
    chat.draft.value = '新对话草稿'
    await chat.navigate('one')
    await tick()
    chat.draft.value = '第一段草稿'
    await chat.navigate('two')
    await tick()
    expect(chat.draft.value).toBe('')
    await chat.navigate('one')
    await tick()
    expect(chat.draft.value).toBe('第一段草稿')
    await chat.navigate()
    await tick()
    expect(chat.draft.value).toBe('新对话草稿')
  })
  it('旧会话的迟到响应不能覆盖新会话', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? []
          : path.endsWith('/old')
            ? new Promise((resolve) => {
                resolveOld = resolve
              })
            : history('new'),
    )
    const chat = await mount()
    await chat.navigate('old')
    await tick()
    await chat.navigate('new')
    await tick()
    resolveOld(history('old'))
    await tick()
    expect(chat.detail.value?.conversation.id).toBe('new')
  })
  it('发送中防重复，结果不确定时保留原幂等命令重试', async () => {
    let rejectSend: (error: Error) => void = () => {}
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? []
          : path.endsWith('/runs')
            ? new Promise((_resolve, reject) => {
                rejectSend = reject
              })
            : history('one'),
    )
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    chat.draft.value = '问题'
    const sending = chat.send()
    await tick()
    await chat.send()
    const calls = () => harness.api.mock.calls.filter(([path]) => String(path).endsWith('/runs'))
    expect(calls()).toHaveLength(1)
    const firstCommand = calls()[0]?.[1]
    rejectSend(new Error('网络中断'))
    await sending
    const retry = chat.send()
    await tick()
    expect(calls()[1]?.[1]).toEqual(firstCommand)
    rejectSend(new Error('网络仍中断'))
    await retry
    expect(chat.draft.value).toBe('问题')
  })
})
