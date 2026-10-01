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

const harness = vi.hoisted(() => ({
  api: vi.fn(),
  stateFetch: vi.fn(),
  cleanups: [] as (() => void)[],
}))
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
import { effectScope, nextTick, ref, watch } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { modelKey, useChat } from '../../plugins/features/chat-webui/client/useChat.js'
import { createChatPreferences } from '../../plugins/features/chat-webui/client/preferences.js'
import type { Session } from '../../plugins/features/chat-webui/client/session.js'

const scope = () => effectScope()
let cleanup = () => {}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
  harness.cleanups.splice(0).forEach((fn) => fn())
  vi.restoreAllMocks()
  harness.api.mockReset()
  harness.stateFetch.mockReset()
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
const session: Session = {
  actorId: 'a',
  workspaceId: 'w',
  displayName: '测试',
  roles: [],
  accountPath: '/auth/user/',
}
async function mount(identity = () => session) {
  const fetcher = globalThis.fetch
  if (!harness.stateFetch.getMockImplementation())
    harness.stateFetch.mockImplementation(async () => new Response(new ReadableStream()))
  vi.stubGlobal('fetch', (url: string, options: RequestInit) =>
    url === '/api/ai/conversations/events'
      ? harness.stateFetch(url, options)
      : fetcher(url, options),
  )
  const router = useApi().router
  await router.push({ path: '/', query: {} })
  const effect = scope()
  const chat = effect.run(() => useChat(identity))!
  cleanup = () => effect.stop()
  await tick()
  return chat
}
describe('聊天会话状态', () => {
  it('删除推送清除当前对话，忽略其他空间及删除后的旧摘要', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    harness.stateFetch.mockImplementation(
      async () =>
        new Response(new ReadableStream({ start: (controller) => (source = controller) })),
    )
    const original = {
      ...history('one'),
      conversation: { ...history('one').conversation, workspaceId: session.workspaceId },
    }
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog' ? catalog : path.includes('?') ? [original.conversation] : original,
    )
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    const push = (event: object) =>
      source!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    push({ sequence: 1, type: 'deleted', conversationId: 'one', workspaceId: 'other' })
    await tick()
    expect(chat.currentId.value).toBe('one')
    push({ sequence: 2, type: 'deleted', conversationId: 'one', workspaceId: session.workspaceId })
    await tick()
    push({ sequence: 3, type: 'conversation', conversation: original.conversation })
    await tick()
    expect(chat.currentId.value).toBe('')
    expect(chat.detail.value).toBeUndefined()
    expect(chat.conversations.value).toEqual([])
  })
  it('删除失败保留对话与草稿，成功后清除当前会话且旧快照不能恢复它', async () => {
    const original = history('one')
    harness.api.mockImplementation(async (path: string, _body: unknown, method: string) => {
      if (method === 'DELETE') throw new Error('删除失败')
      return path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? [original.conversation]
          : original
    })
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    chat.draft.value = '保留草稿'
    await expect(chat.remove('one')).rejects.toThrow('删除失败')
    expect(chat.currentId.value).toBe('one')
    expect(chat.draft.value).toBe('保留草稿')
    harness.api.mockImplementation(async (path: string, _body: unknown, method: string) =>
      method === 'DELETE'
        ? undefined
        : path === '/ai/catalog'
          ? catalog
          : path.includes('?')
            ? [original.conversation]
            : original,
    )
    await chat.remove('one')
    expect(harness.api).toHaveBeenCalledWith('/ai/conversations/one', {}, 'DELETE')
    await tick()
    expect(chat.currentId.value).toBe('')
    expect(chat.detail.value).toBeUndefined()
    expect(chat.conversations.value).toEqual([])
    expect(chat.draft.value).toBe('')
  })
  it('工具状态和终态早于发送响应到达时保留最新列表，不重复增加修订号', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    let respond: ((value: unknown) => void) | undefined
    harness.stateFetch.mockImplementation(
      async () =>
        new Response(new ReadableStream({ start: (controller) => (source = controller) })),
    )
    const original = { ...history('one').conversation, workspaceId: session.workspaceId }
    harness.api.mockImplementation(async (path: string) => {
      if (path === '/ai/catalog') return catalog
      if (path.endsWith('/runs')) return new Promise((resolve) => (respond = resolve))
      if (path.includes('?')) return [original]
      return { ...history('one'), conversation: original }
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          `data: ${JSON.stringify({ ...event(1, 'run-end', { status: 'completed' }), runId: 'run', conversationId: 'one' })}\n\n`,
        ),
    )
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    chat.draft.value = '创建任务'
    const sending = chat.send()
    await tick()
    source!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ sequence: 1, type: 'conversation', conversation: { ...original, title: '新标题', selectedNodeId: 'reply', activeRunId: null, revision: 4, todos: [{ id: 'a', text: '任务', status: 'pending' }] } })}\n\n`,
      ),
    )
    await tick()
    respond!({
      id: 'run',
      conversationId: 'one',
      userNodeId: 'user',
      replyNodeId: 'reply',
      status: 'running',
      input: { text: '创建任务' },
      model,
      thinking: null,
      createdAt: 1,
    })
    await sending
    await tick()
    expect(chat.detail.value?.conversation).toMatchObject({
      title: '新标题',
      revision: 4,
      activeRunId: null,
      todos: [{ id: 'a', text: '任务', status: 'pending' }],
    })
  })
  it('当前会话实时接收待办进度和标题，保留消息与草稿并拒绝旧状态', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    harness.stateFetch.mockImplementation(
      async () =>
        new Response(new ReadableStream({ start: (controller) => (source = controller) })),
    )
    const original = {
      ...history('one').conversation,
      workspaceId: session.workspaceId,
      revision: 1,
    }
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? [original]
          : path.endsWith('/two')
            ? history('two')
            : { ...history('one'), conversation: original },
    )
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    chat.draft.value = '保留草稿'
    const path = chat.detail.value?.path
    const emit = (sequence: number, revision: number, status: string) =>
      source!.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ sequence, type: 'conversation', conversation: { ...original, revision, title: 'AI 修改的标题', todos: [{ id: 'a', text: '实现功能', status }] } })}\n\n`,
        ),
      )
    emit(1, 2, 'in_progress')
    await tick()
    expect(chat.detail.value?.conversation).toMatchObject({
      title: 'AI 修改的标题',
      todos: [{ status: 'in_progress' }],
    })
    emit(2, 3, 'completed')
    emit(3, 2, 'pending')
    await tick()
    expect(chat.detail.value?.conversation.todos).toEqual([
      { id: 'a', text: '实现功能', status: 'completed' },
    ])
    expect(chat.detail.value?.path).toBe(path)
    expect(chat.draft.value).toBe('保留草稿')
    await chat.navigate('two')
    await tick()
    expect(chat.detail.value?.conversation.todos).toBeUndefined()
  })
  it('独立状态流在不打开对话时同步名称和终态，忽略旧版本与其他空间', async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    harness.stateFetch.mockImplementation(
      async () =>
        new Response(new ReadableStream({ start: (controller) => (source = controller) })),
    )
    const original = {
      ...history('background').conversation,
      workspaceId: session.workspaceId,
      title: '原名称',
      revision: 1,
      activeRunId: 'run',
    }
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog' ? catalog : path.includes('?') ? [original] : history('other'),
    )
    const chat = await mount()
    await chat.navigate('other')
    await tick()
    const current = chat.detail.value
    const requests = harness.api.mock.calls.length
    const emit = (
      sequence: number,
      changes: Partial<
        Omit<typeof original, 'activeRunId' | 'archivedAt'> & {
          activeRunId: string | null
          archivedAt: number | null
        }
      >,
    ) =>
      source!.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ sequence, type: 'conversation', conversation: { ...original, ...changes } })}\n\n`,
        ),
      )
    emit(1, { title: '新名称', revision: 2 })
    await tick()
    const background = () => chat.conversations.value.find((item) => item.id === 'background')
    expect(background()?.title).toBe('新名称')
    emit(2, { title: '新名称', revision: 3, activeRunId: null })
    await tick()
    expect(background()?.activeRunId).toBeNull()
    emit(3, { revision: 1 })
    emit(4, { workspaceId: 'other-space', revision: 100 })
    await tick()
    expect(background()).toMatchObject({
      title: '新名称',
      revision: 3,
      activeRunId: null,
    })
    expect(chat.detail.value).toBe(current)
    expect(harness.api.mock.calls).toHaveLength(requests)
    expect(harness.stateFetch).toHaveBeenCalledTimes(1)
    emit(5, { revision: 4, archivedAt: 1, activeRunId: null })
    emit(6, { revision: 3, activeRunId: null })
    await tick()
    expect(background()).toBeUndefined()
  })

  it('身份切换回收原状态流，并清除原空间的修订号记录', async () => {
    const identity = ref(session)
    const sources: ReadableStreamDefaultController<Uint8Array>[] = []
    const signals: AbortSignal[] = []
    harness.stateFetch.mockImplementation(async (_url: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal)
      return new Response(new ReadableStream({ start: (source) => sources.push(source) }))
    })
    harness.api.mockImplementation(async (path: string) => (path === '/ai/catalog' ? catalog : []))
    const chat = await mount(() => identity.value)
    const emit = (source: number, revision: number, workspaceId: string) =>
      sources[source]!.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ sequence: 1, type: 'conversation', conversation: { ...history('one').conversation, revision, workspaceId } })}\n\n`,
        ),
      )
    emit(0, 5, session.workspaceId)
    await tick()
    expect(chat.conversations.value[0]?.revision).toBe(5)
    identity.value = { ...session, workspaceId: 'new-space' }
    await tick()
    expect(signals[0]?.aborted).toBe(true)
    expect(sources).toHaveLength(2)
    expect(chat.conversations.value).toEqual([])
    emit(1, 0, 'new-space')
    await tick()
    expect(chat.conversations.value[0]?.revision).toBe(0)
  })

  it('重连校准列表且快照不能覆盖期间收到的状态，卸载回收连接', async () => {
    vi.useFakeTimers()
    const sources: ReadableStreamDefaultController<Uint8Array>[] = []
    const signals: AbortSignal[] = []
    const cancel = vi.fn()
    harness.stateFetch.mockImplementation(async (_url: string, options: RequestInit) => {
      signals.push(options.signal as AbortSignal)
      return new Response(new ReadableStream({ start: (source) => sources.push(source), cancel }))
    })
    const original = {
      ...history('one').conversation,
      workspaceId: session.workspaceId,
      revision: 1,
      activeRunId: 'run',
    }
    let resolveSnapshot: (value: unknown) => void = () => {}
    let lists = 0
    harness.api.mockImplementation(async (path: string) => {
      if (path === '/ai/catalog') return catalog
      if (++lists === 1) return [original]
      return new Promise((resolve) => (resolveSnapshot = resolve))
    })
    const chat = await mount()
    sources[0]!.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources).toHaveLength(2)
    sources[1]!.enqueue(
      new TextEncoder().encode(
        `data: {"sequence":1,"type":"ready"}\n\ndata: ${JSON.stringify({ sequence: 2, type: 'conversation', conversation: { ...original, title: '已完成', revision: 2, activeRunId: null } })}\n\n`,
      ),
    )
    await tick()
    sources[1]!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ sequence: 3, type: 'conversation', conversation: { ...original, id: 'archived-during-refresh', archivedAt: 1, revision: 2 } })}\n\n`,
      ),
    )
    await tick()
    resolveSnapshot([original, { ...original, id: 'archived-during-refresh' }])
    await tick()
    expect(chat.conversations.value).toHaveLength(1)
    expect(chat.conversations.value[0]).toMatchObject({ title: '已完成', activeRunId: null })
    harness.cleanups.splice(0).forEach((fn) => fn())
    await tick()
    expect(signals.at(-1)?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('加载对话详情时，将最新终态写回侧栏', async () => {
    harness.api.mockImplementation(async (path: string) =>
      path === '/ai/catalog'
        ? catalog
        : path.includes('?')
          ? [{ ...history('one').conversation, activeRunId: 'old-run' }]
          : history('one'),
    )
    const chat = await mount()
    await chat.navigate('one')
    await tick()
    expect(chat.conversations.value[0]?.activeRunId).toBeNull()
  })

  it('纯附件消息按会话隔离，发送失败保留附件和幂等请求，确认成功后写入消息历史', async () => {
    setupPreferences()
    const chat = await mount()
    const attachment = {
      type: 'image' as const,
      resourceId: 'file-1',
      mimeType: 'image/png',
      filename: '截图.png',
      url: '/api/workspace-files/resources/file-1/content',
      size: 10,
    }
    chat.attachmentDrafts.set('', [attachment])
    const original = harness.api.getMockImplementation()!
    let fail = true
    harness.api.mockImplementation(async (path: string, body?: RunCommand) => {
      if (path.endsWith('/runs') && fail) throw new Error('网络中断')
      return original(path, body)
    })
    await chat.send()
    expect(chat.currentId.value).toBe('new')
    expect(chat.attachments.value).toEqual([attachment])
    expect(chat.pending.get('new')?.input?.attachments).toEqual([attachment])
    const key = chat.pending.get('new')!.idempotencyKey
    await chat.navigate()
    await tick()
    expect(chat.attachments.value).toEqual([])
    await chat.navigate('new')
    await tick()
    fail = false
    await chat.send()
    expect(chat.attachments.value).toEqual([])
    expect(chat.detail.value!.path[0]!.content).toContainEqual(attachment)
    expect(
      harness.api.mock.calls.filter(([path]) => path.endsWith('/runs')).at(-1)?.[1].idempotencyKey,
    ).toBe(key)
  })
  function setupPreferences() {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    })
    const source = structuredClone(catalog)
    source.agents.push({ ...source.agents[0]!, id: 'other', title: '另一位助理' })
    harness.api.mockImplementation(
      async (path: string, body?: RunCommand & { agentId?: string }) => {
        if (path === '/ai/catalog') return source
        if (path.includes('?')) return []
        if (path === '/ai/conversations')
          return { ...history('new').conversation, agentId: body!.agentId }
        if (path.endsWith('/runs'))
          return {
            id: 'run',
            conversationId: 'new',
            userNodeId: 'user',
            replyNodeId: 'reply',
            model: body!.model,
            thinking: body!.thinking,
            input: body!.input,
            createdAt: 1,
          }
        if (path === '/ai/runs/old-run') return { model, thinking: 'high' }
        return {
          ...history('old'),
          path: [{ id: 'old-reply', role: 'assistant', runId: 'old-run', content: [] }],
        }
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify(event(1, 'run-end', { status: 'completed' }))}\n\n`),
      ),
    )
    return { data, source }
  }

  it('编辑旧消息在原父节点创建分支，重新生成指定回复且保留输入草稿', async () => {
    setupPreferences()
    const original = harness.api.getMockImplementation()!
    let sequence = 0
    harness.api.mockImplementation(async (path: string, command?: RunCommand) => {
      const result = await original(path, command)
      if (!path.endsWith('/runs')) return result
      sequence++
      return {
        ...result,
        id: `run-${sequence}`,
        userNodeId: command?.operation === 'regenerate' ? 'user-1' : `user-${sequence}`,
        replyNodeId: `reply-${sequence}`,
        input: command?.input ?? { text: '原问题' },
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const runId = url.split('/runs/')[1]!.split('/')[0]!
        return new Response(
          `data: ${JSON.stringify({ ...event(1, 'run-end', { status: 'completed' }), runId })}\n\n`,
        )
      }),
    )
    const chat = await mount()
    chat.draft.value = '原问题'
    await chat.send()
    await tick()
    const user = chat.detail.value!.path[0]!
    const reply = chat.detail.value!.path[1]!
    chat.draft.value = '下一轮草稿'
    await chat.send(false, user, '修改后的问题')
    await tick()
    expect(chat.detail.value!.path.map((node) => node.id)).toEqual(['user-2', 'reply-2'])
    expect(chat.detail.value!.nodes.find((node) => node.id === 'user-2')?.parentId).toBeNull()
    expect(chat.detail.value!.nodes.some((node) => node.id === user.id)).toBe(true)
    expect(chat.branches(chat.detail.value!.path[1]!).map((node) => node.id)).toEqual([
      'reply-1',
      'reply-2',
    ])
    await chat.send(true, reply)
    await tick()
    expect(chat.detail.value!.path.map((node) => node.id)).toEqual(['user-1', 'reply-3'])
    expect(chat.draft.value).toBe('下一轮草稿')
    expect(
      harness.api.mock.calls.filter(([path]) => path.endsWith('/runs')).at(-1)?.[1],
    ).toMatchObject({ operation: 'regenerate', targetNodeId: 'reply-1' })
    expect(chat.branches(chat.detail.value!.path[1]!)).toHaveLength(3)
    chat.detail.value = {
      ...chat.detail.value!,
      nodes: [
        ...chat.detail.value!.nodes,
        { ...user, id: 'follow-up-user', parentId: 'reply-2', createdAt: 10 },
        { ...reply, id: 'follow-up-reply', parentId: 'follow-up-user', createdAt: 11 },
      ],
    }
    await chat.selectBranch('reply-2')
    expect(harness.api).toHaveBeenCalledWith(
      '/ai/conversations/new/selection',
      expect.objectContaining({ nodeId: 'follow-up-reply', expectedNodeId: 'reply-3' }),
      'PATCH',
    )
  })

  it('各助理保存已提交的设置，新对话及重新挂载恢复，浏览历史不覆盖偏好', async () => {
    setupPreferences()
    let chat = await mount()
    chat.thinking.value = 'low'
    chat.draft.value = '问题'
    await chat.send()
    await chat.navigate()
    await tick()
    expect(chat.thinking.value).toBe('low')
    chat.agentId.value = 'other'
    await tick()
    expect(chat.thinking.value).toBe('high')
    const plain = modelKey({ providerId: 'p', modelId: 'plain' })
    chat.selectedModel.value = plain
    chat.draft.value = '另一位助理的问题'
    await chat.send()
    await chat.navigate()
    await tick()
    expect(chat.selectedModel.value).toBe(plain)
    expect(chat.thinking.value).toBeNull()
    chat.agentId.value = 'agent'
    await tick()
    expect(chat.selectedModel.value).toBe(modelKey(model))
    expect(chat.thinking.value).toBe('low')
    await chat.navigate('old')
    await tick()
    expect(chat.thinking.value).toBe('high')
    await chat.navigate()
    await tick()
    expect(chat.thinking.value).toBe('low')
    cleanup()
    harness.cleanups.splice(0).forEach((fn) => fn())
    chat = await mount()
    expect(chat.thinking.value).toBe('low')
    chat.agentId.value = 'other'
    await tick()
    expect(chat.selectedModel.value).toBe(plain)
    expect(chat.thinking.value).toBeNull()
  })

  it('按用户与空间隔离偏好，身份切换不沿用其他用户的记录', async () => {
    setupPreferences()
    createChatPreferences().write(session, 'agent', { model, thinking: 'low' })
    const identity = ref(session)
    const chat = await mount(() => identity.value)
    expect(chat.thinking.value).toBe('low')
    for (const next of [
      { ...session, actorId: 'b' },
      { ...session, workspaceId: 'other-space' },
    ]) {
      identity.value = next
      await tick()
      expect(chat.thinking.value).toBe('high')
    }
    identity.value = session
    await tick()
    expect(chat.thinking.value).toBe('low')
  })

  it('失效模型回退到助理默认模型，失效档位回退到支持的默认档位', async () => {
    const { source } = setupPreferences()
    source.agents[0]!.defaultModel = { providerId: 'p', modelId: 'plain' }
    const preferences = createChatPreferences()
    preferences.write(session, 'agent', {
      model: { providerId: 'deleted', modelId: 'm' },
      thinking: 'low',
    })
    const chat = await mount()
    expect(chat.selectedModel.value).toBe(modelKey(source.agents[0]!.defaultModel))
    expect(chat.thinking.value).toBeNull()
    preferences.write(session, 'agent', { model, thinking: 'removed-level' })
    await chat.load()
    expect(chat.selectedModel.value).toBe(modelKey(model))
    expect(chat.thinking.value).toBe('high')
  })

  it('损坏记录和存储异常不阻断聊天，存储不可用时在页面内记忆', async () => {
    const { data } = setupPreferences()
    createChatPreferences().write(session, 'agent', { model, thinking: 'low' })
    for (const key of data.keys()) data.set(key, '{broken')
    const chat = await mount()
    expect(chat.thinking.value).toBe('high')
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('禁用存储')
      },
      setItem: () => {
        throw new Error('禁用存储')
      },
    })
    chat.thinking.value = 'low'
    chat.draft.value = '问题'
    await chat.send()
    await chat.navigate()
    await tick()
    expect(chat.thinking.value).toBe('low')
    expect(chat.error.value).toBe('')
  })

  it('未发送的选择和被拒绝的请求不覆盖最后使用的设置', async () => {
    setupPreferences()
    createChatPreferences().write(session, 'agent', { model, thinking: 'low' })
    const chat = await mount()
    chat.thinking.value = 'high'
    chat.draft.value = '问题'
    harness.api.mockRejectedValueOnce(new Error('请求失败'))
    await chat.send()
    await chat.load()
    expect(chat.thinking.value).toBe('low')
  })

  it('断线后携带事件游标重连，结束时原地保存内容而不重载历史', async () => {
    vi.useFakeTimers()
    let states: ReadableStreamDefaultController<Uint8Array> | undefined
    harness.stateFetch.mockImplementation(
      async () => new Response(new ReadableStream({ start: (source) => (states = source) })),
    )
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
    states!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ sequence: 1, type: 'conversation', conversation: { ...activeHistory().conversation, workspaceId: session.workspaceId, title: '其他标签页修改的名称', activeRunId: null, revision: 2 } })}\n\n`,
      ),
    )
    await tick()
    await vi.advanceTimersByTimeAsync(500)
    await tick()
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/ai/runs/run/events?after=0',
      '/api/ai/runs/run/events?after=1',
    ])
    expect(chat.activeRunId.value).toBeNull()
    expect(chat.conversations.value.find((item) => item.id === 'one')?.title).toBe(
      '其他标签页修改的名称',
    )
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
  it('同一对话重载保留消息和流式文本，失败不清屏，切换对话立即清空', async () => {
    setupPreferences()
    const chat = await mount()
    chat.draft.value = '保留这条消息'
    await chat.send()
    await tick()
    const detail = chat.detail.value
    const live = chat.replies.get('run')
    let rejectLoad: (error: Error) => void = () => {}
    harness.api.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject
        }),
    )
    const loading = chat.load()
    await tick()
    expect(chat.loading.value).toBe(true)
    expect(chat.detail.value).toBe(detail)
    expect(chat.replies.get('run')).toBe(live)
    rejectLoad(new Error('暂时断线'))
    await loading
    expect(chat.loading.value).toBe(false)
    expect(chat.detail.value).toBe(detail)
    expect(chat.error.value).toBe('暂时断线')
    let resolveLoad: (value: unknown) => void = () => {}
    harness.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    )
    await chat.navigate('other')
    await tick()
    expect(chat.loading.value).toBe(true)
    expect(chat.detail.value).toBeUndefined()
    expect(chat.replies.size).toBe(0)
    resolveLoad(history('other'))
    await tick()
    expect(chat.detail.value?.conversation.id).toBe('other')
    expect(chat.loading.value).toBe(false)
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
