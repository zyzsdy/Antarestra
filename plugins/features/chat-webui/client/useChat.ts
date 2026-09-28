import { computed, onUnmounted, reactive, ref, shallowRef, shallowReactive, watch } from 'vue'
import { useApi, ApiError } from '@antarestra/webui/api'
import type {
  AgentPreset,
  ChatMessage,
  Conversation,
  MessageNode,
  ModelDefinition,
  ModelRef,
  RunCommand,
  RunRecord,
  RunStatus,
} from '@antarestra/contracts'
import type { Session } from './session.js'
import { applyEvent, emptyReply, readEvents } from './stream.js'
import { createChatPreferences } from './preferences.js'

interface Catalog {
  agents: AgentPreset[]
  defaultAgentId: string | null
  providers: { id: string; title: string; models: ModelDefinition[] }[]
}
interface History {
  conversation: Conversation
  nodes: MessageNode[]
  path: MessageNode[]
}
export const modelKey = (model: ModelRef) => JSON.stringify([model.providerId, model.modelId])

export function useChat(identity: () => Session | undefined) {
  const { api, router } = useApi()
  const preferences = createChatPreferences()
  const catalog = shallowRef<Catalog>({ agents: [], providers: [], defaultAgentId: null })
  const conversations = ref<Conversation[]>([])
  const archived = ref(false)
  const more = ref(false)
  const listing = ref(false)
  const loading = ref(false)
  const sending = ref(false)
  const stopping = ref(false)
  const error = ref('')
  const listError = ref('')
  const detail = shallowRef<History>()
  const runs = shallowReactive(new Map<string, RunRecord>())
  const drafts = reactive(new Map<string, string>())
  const pending = shallowReactive(new Map<string, RunCommand>())
  const agentId = ref('')
  const selectedModel = ref('')
  const thinking = ref<string | null>(null)
  const reply = shallowRef(emptyReply())
  const replies = shallowReactive(new Map<string, ReturnType<typeof emptyReply>>())
  const disconnected = ref(false)
  const currentId = computed(() =>
    typeof router.currentRoute.value.query.conversation === 'string'
      ? router.currentRoute.value.query.conversation
      : '',
  )
  const draft = computed({
    get: () => drafts.get(currentId.value) ?? '',
    set: (value: string) => drafts.set(currentId.value, value),
  })
  const agent = computed(() =>
    catalog.value.agents.find(
      (item) => item.id === (detail.value?.conversation.agentId ?? agentId.value),
    ),
  )
  const modelOptions = computed(() =>
    catalog.value.providers.flatMap((provider) =>
      provider.models
        .filter((model) =>
          agent.value?.models.some(
            (ref) => ref.providerId === provider.id && ref.modelId === model.id,
          ),
        )
        .map((model) => ({
          id: modelKey({ providerId: provider.id, modelId: model.id }),
          name: model.title,
          group: provider.title,
          model,
          ref: { providerId: provider.id, modelId: model.id },
        })),
    ),
  )
  const model = computed(() => modelOptions.value.find((item) => item.id === selectedModel.value))
  const levels = computed(() => model.value?.model.thinkingLevels ?? [])
  const activeRunId = computed(() => detail.value?.conversation.activeRunId ?? null)
  const lastRun = computed(() => {
    const node = detail.value?.path.at(-1)
    return node ? runs.get(node.runId) : undefined
  })
  const interrupted = computed(
    () => lastRun.value && ['failed', 'cancelled', 'interrupted'].includes(lastRun.value.status),
  )
  const unavailable = computed(() =>
    !agent.value
      ? '当前 Agent 不可用，请联系管理员配置。'
      : !model.value
        ? '当前 Agent 暂无可用模型。'
        : '',
  )
  let identityEpoch = 0
  let epoch = 0
  let listEpoch = 0
  let stream: AbortController | undefined
  let alive = true
  const message = (cause: unknown) => (cause instanceof Error ? cause.message : '请求失败，请重试')
  const same = (id: string, turn: number) => alive && turn === epoch && currentId.value === id
  function remember(conversation: Conversation) {
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id)
    if ((conversation.archivedAt !== null) === archived.value) {
      conversations.value.push(conversation)
      conversations.value.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }
  }
  function acceptRun(history: History, run: RunRecord, command: RunCommand) {
    let user = history.nodes.find((node) => node.id === run.userNodeId)
    if (!user) {
      user = {
        id: run.userNodeId,
        conversationId: run.conversationId,
        parentId: command.expectedNodeId,
        runId: run.id,
        role: 'user',
        content: [{ type: 'text', text: run.input.text }, ...(run.input.attachments ?? [])],
        input: run.input,
        createdAt: run.createdAt,
        version: 1,
        versionCount: 1,
      }
    }
    const siblings = history.nodes.filter(
      (node) => node.role === 'assistant' && node.parentId === user.id,
    )
    const node: MessageNode = {
      id: run.replyNodeId,
      conversationId: run.conversationId,
      parentId: user.id,
      runId: run.id,
      role: 'assistant',
      content: [],
      createdAt: run.createdAt,
      version: siblings.length + 1,
      versionCount: siblings.length + 1,
    }
    const parentIndex = history.path.findIndex((item) => item.id === user.parentId)
    const conversation = {
      ...history.conversation,
      selectedNodeId: node.id,
      activeRunId: run.id,
      revision: command.expectedRevision + 1,
      lastActivityAt: run.createdAt,
    }
    detail.value = {
      conversation,
      nodes: [
        ...history.nodes.filter((item) => item.id !== user.id && item.id !== node.id),
        user,
        node,
      ],
      path: [...history.path.slice(0, parentIndex + 1), user, node],
    }
    remember(conversation)
  }
  function chooseModel(preferred?: ModelRef, preferredThinking?: string | null) {
    const key = preferred
      ? modelKey(preferred)
      : agent.value
        ? modelKey(agent.value.defaultModel)
        : ''
    const preferredModel = modelOptions.value.find((item) => item.id === key)
    selectedModel.value =
      preferredModel?.id ??
      modelOptions.value.find(
        (item) => agent.value && item.id === modelKey(agent.value.defaultModel),
      )?.id ??
      modelOptions.value[0]?.id ??
      ''
    const initial = preferredModel ? preferredThinking : undefined
    const fallback = agent.value?.defaultThinking
    thinking.value =
      initial && levels.value.includes(initial)
        ? initial
        : fallback && levels.value.includes(fallback)
          ? fallback
          : (levels.value[0] ?? null)
  }
  function chooseNewModel() {
    const session = identity()
    const saved = session && agent.value ? preferences.read(session, agent.value.id) : undefined
    chooseModel(saved?.model, saved?.thinking)
  }
  watch(agentId, () => {
    if (!currentId.value) chooseNewModel()
  })
  watch(
    selectedModel,
    () => {
      if (!thinking.value || !levels.value.includes(thinking.value))
        thinking.value =
          agent.value?.defaultThinking && levels.value.includes(agent.value.defaultThinking)
            ? agent.value.defaultThinking
            : (levels.value[0] ?? null)
    },
    { flush: 'sync' },
  )

  async function list(append = false) {
    const turn = ++listEpoch
    listing.value = true
    listError.value = ''
    try {
      const items = await api<Conversation[]>(
        `/ai/conversations?archived=${archived.value}&offset=${append ? conversations.value.length : 0}&limit=50`,
      )
      if (turn !== listEpoch || !alive) return
      conversations.value = append
        ? [...new Map([...conversations.value, ...items].map((item) => [item.id, item])).values()]
        : items
      more.value = items.length === 50
    } catch (cause) {
      if (turn === listEpoch && alive) listError.value = message(cause)
    } finally {
      if (turn === listEpoch) listing.value = false
    }
  }
  watch(archived, () => {
    conversations.value = []
    void list()
  })
  async function load() {
    const turn = ++epoch
    const id = currentId.value
    stream?.abort()
    disconnected.value = false
    detail.value = undefined
    reply.value = emptyReply()
    replies.clear()
    error.value = ''
    if (!id) {
      loading.value = false
      chooseNewModel()
      return
    }
    loading.value = true
    try {
      const result = await api<History>(`/ai/conversations/${encodeURIComponent(id)}`)
      const ids = [
        ...new Set(
          result.path.filter((node) => node.role === 'assistant').map((node) => node.runId),
        ),
      ]
      const records = await Promise.all(
        ids.map((runId) => api<RunRecord>(`/ai/runs/${encodeURIComponent(runId)}`)),
      )
      if (!same(id, turn)) return
      for (const run of records) runs.set(run.id, run)
      detail.value = result
      const latest = records.at(-1)
      chooseModel(latest?.model, latest?.thinking)
      if (result.conversation.activeRunId) void connect(result.conversation.activeRunId, id, turn)
    } catch (cause) {
      if (same(id, turn)) error.value = message(cause)
    } finally {
      if (same(id, turn)) loading.value = false
    }
  }
  async function connect(runId: string, id = currentId.value, turn = epoch) {
    stream?.abort()
    const controller = new AbortController()
    stream = controller
    reply.value = emptyReply()
    replies.set(runId, reply.value)
    disconnected.value = false
    const messages: ChatMessage[] = []
    for (let attempt = 0; attempt < 4 && same(id, turn) && !controller.signal.aborted; attempt++) {
      try {
        const response = await fetch(
          `/api/ai/runs/${encodeURIComponent(runId)}/events?after=${reply.value.sequence}`,
          {
            signal: controller.signal,
            credentials: 'same-origin',
            cache: 'no-store',
          },
        )
        if (response.status === 401 || response.status === 403) {
          await api(`/ai/runs/${encodeURIComponent(runId)}`)
          return
        }
        await readEvents(
          response,
          (event) => {
            if (same(id, turn) && !controller.signal.aborted && event.runId === runId) {
              if (event.sequence <= reply.value.sequence) return
              applyEvent(reply.value, event)
              reply.value = { ...reply.value }
              replies.set(runId, reply.value)
              if (event.type === 'message') messages.push(event.data as unknown as ChatMessage)
              if (event.type === 'run-end') {
                const run = runs.get(runId)
                const history = detail.value
                if (!run || !history) return
                const result = event.data as { status: RunStatus; error?: RunRecord['error'] }
                runs.set(runId, {
                  ...run,
                  status: result.status,
                  error: result.error ?? null,
                  endedAt: event.createdAt,
                  messages,
                })
                const content = [...reply.value.completed, ...reply.value.pending]
                const finish = (node: MessageNode) =>
                  node.id === run.replyNodeId ? { ...node, content } : node
                const conversation = {
                  ...history.conversation,
                  activeRunId: null,
                  revision: history.conversation.revision + 1,
                  lastActivityAt: event.createdAt,
                }
                detail.value = {
                  conversation,
                  nodes: history.nodes.map(finish),
                  path: history.path.map(finish),
                }
                remember(conversation)
              }
            }
          },
          controller.signal,
        )
        if (!same(id, turn) || controller.signal.aborted) return
        if (reply.value.ended) {
          return
        }
        throw new Error('回复连接已断开')
      } catch (cause) {
        if (!same(id, turn) || controller.signal.aborted) return
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          error.value = message(cause)
          break
        }
        if (attempt === 3) break
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, 500 * 2 ** attempt)
          controller.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
    if (same(id, turn) && !controller.signal.aborted) disconnected.value = true
  }
  async function navigate(id = '') {
    await router.push({ path: '/', query: id ? { conversation: id } : {} })
  }
  async function refreshCatalog() {
    const turn = identityEpoch
    const value = await api<Catalog>('/ai/catalog')
    if (!alive || turn !== identityEpoch) return
    catalog.value = value
    agentId.value =
      catalog.value.agents.find((item) => item.id === catalog.value.defaultAgentId)?.id ??
      catalog.value.agents[0]?.id ??
      ''
  }
  async function initialize() {
    if (!identity()) return
    const turn = ++epoch
    try {
      await refreshCatalog()
      if (!alive || turn !== epoch) return
      await Promise.all([list(), load()])
    } catch (cause) {
      if (alive) error.value = message(cause)
    }
  }
  watch(currentId, () => {
    if (identity() && detail.value?.conversation.id !== currentId.value) void load()
  })
  watch(
    () => `${identity()?.actorId ?? ''}/${identity()?.workspaceId ?? ''}`,
    () => {
      identityEpoch++
      epoch++
      listEpoch++
      stream?.abort()
      drafts.clear()
      pending.clear()
      runs.clear()
      replies.clear()
      detail.value = undefined
      conversations.value = []
      void initialize()
    },
    { immediate: true },
  )

  async function send(regenerate = false) {
    if (
      sending.value ||
      loading.value ||
      activeRunId.value ||
      !model.value ||
      !agent.value ||
      detail.value?.conversation.archivedAt
    )
      return
    if (!regenerate && !pending.has(currentId.value) && (!draft.value.trim() || interrupted.value))
      return
    const owner = identityEpoch
    const session = identity()
    const usedAgentId = agent.value.id
    sending.value = true
    error.value = ''
    let id = currentId.value
    const text = draft.value
    const selected = { ...model.value.ref }
    const intensity = thinking.value
    let history = detail.value
    try {
      if (!id) {
        const created = await api<Conversation>('/ai/conversations', {
          agentId: agent.value.id,
          title: text.replace(/\s+/g, ' ').trim().slice(0, 30),
        })
        if (!alive || owner !== identityEpoch) return
        id = created.id
        history = { conversation: created, nodes: [], path: [] }
        remember(created)
        drafts.set(id, text)
        if (drafts.get('') === text) drafts.delete('')
        if (!currentId.value) {
          detail.value = history
          await navigate(id)
        }
      }
      let command = pending.get(id)
      if (!command) {
        const fresh = history ?? (await api<History>(`/ai/conversations/${encodeURIComponent(id)}`))
        history = fresh
        if (!alive || owner !== identityEpoch) return
        command = {
          operation: regenerate ? 'regenerate' : 'send',
          expectedRevision: fresh.conversation.revision,
          expectedNodeId: fresh.conversation.selectedNodeId,
          idempotencyKey: crypto.randomUUID(),
          model: selected,
          thinking: intensity,
          ...(regenerate
            ? { targetNodeId: fresh.conversation.selectedNodeId! }
            : { input: { text } }),
        }
        pending.set(id, command)
      }
      const result = await api<RunRecord>(
        `/ai/conversations/${encodeURIComponent(id)}/runs`,
        command,
      )
      if (!alive || owner !== identityEpoch) return
      if (session)
        preferences.write(session, usedAgentId, { model: result.model, thinking: result.thinking })
      pending.delete(id)
      if (drafts.get(id) === command.input?.text) drafts.delete(id)
      runs.set(result.id, result)
      if (currentId.value === id && history) {
        acceptRun(history, result, command)
        void connect(result.id)
      }
    } catch (cause) {
      if (!alive || owner !== identityEpoch) return
      if (cause instanceof ApiError && cause.status < 500) pending.delete(id)
      if (currentId.value === id || !id) {
        if (cause instanceof ApiError && cause.status === 409) await load()
        error.value = message(cause)
      }
    } finally {
      sending.value = false
    }
  }
  async function stop() {
    const id = currentId.value
    const runId = activeRunId.value
    if (!runId || stopping.value) return
    stopping.value = true
    try {
      await api(`/ai/runs/${encodeURIComponent(runId)}/cancel`, {})
    } catch (cause) {
      if (id === currentId.value) error.value = message(cause)
    } finally {
      stopping.value = false
    }
  }
  async function continuePrevious() {
    const history = detail.value
    const run = lastRun.value
    if (!history || !run || sending.value) return
    sending.value = true
    const id = history.conversation.id
    try {
      const user = history.nodes.find((node) => node.id === run.userNodeId)
      await api(
        `/ai/conversations/${encodeURIComponent(id)}/selection`,
        {
          expectedRevision: history.conversation.revision,
          expectedNodeId: history.conversation.selectedNodeId,
          nodeId: user?.parentId ?? null,
        },
        'PATCH',
      )
      if (!drafts.get(id)) drafts.set(id, run.input.text)
      if (id === currentId.value) await load()
    } catch (cause) {
      if (id === currentId.value) error.value = message(cause)
    } finally {
      sending.value = false
    }
  }
  async function update(id: string, changes: { title?: string; archived?: boolean }) {
    const result = await api<Conversation>(
      `/ai/conversations/${encodeURIComponent(id)}`,
      changes,
      'PATCH',
    )
    if (detail.value?.conversation.id === id)
      detail.value = { ...detail.value, conversation: result }
    await list()
  }
  onUnmounted(() => {
    alive = false
    epoch++
    listEpoch++
    stream?.abort()
    drafts.clear()
    pending.clear()
  })
  return {
    catalog,
    conversations,
    archived,
    more,
    listing,
    loading,
    sending,
    stopping,
    error,
    listError,
    detail,
    runs,
    draft,
    agentId,
    agent,
    selectedModel,
    modelOptions,
    thinking,
    levels,
    activeRunId,
    lastRun,
    interrupted,
    unavailable,
    reply,
    replies,
    disconnected,
    currentId,
    pending,
    list,
    load,
    navigate,
    initialize,
    send,
    stop,
    continuePrevious,
    update,
  }
}
