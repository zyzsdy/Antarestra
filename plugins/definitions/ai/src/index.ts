import { randomUUID } from 'node:crypto'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineDatabasePlugin } from '@antarestra/database'
import type { RequestAccess } from '@antarestra/rbac'
import type {
  AgentPreset,
  AiEvent,
  Conversation,
  ConversationTodo,
  MessageNode,
  RunCommand,
  RunRecord,
  UserInput,
} from '@antarestra/contracts'
import type {
  Config,
  AgentDefinition,
  ExecutionBackend,
  Extension,
  ModelDriver,
  Provider,
  Registration,
  ResourceResolver,
  RunContext,
  SkillService,
  Tool,
} from './types.js'
import { Registry } from './registry.js'
import {
  appendEvent,
  conversationFields,
  decode,
  migrations,
  pluginId,
  row,
  saveRun,
} from './store.js'
import type { Tables } from './store.js'
import { AiError, canonical, check, compile, freeze, identifier, json, payload } from './utils.js'
import { Running } from './runtime.js'
import { routes } from './http.js'
import { validateAgent, validateCommand } from './validation.js'
export * from './types.js'
export { AiError } from './utils.js'
export { validateAgent } from './validation.js'
export type * from '@antarestra/contracts'

export interface Access {
  readonly actorId: string
  readonly workspaceId: string
}
export interface Bound {
  agent: Registration<AgentPreset>
  backend: Registration<ExecutionBackend>
  providers: Map<string, Registration<Provider>>
  drivers: Map<string, Registration<ModelDriver>>
  tools: Map<string, Registration<Tool>>
  extensions: Registration<Extension>[]
  skill?: Registration<SkillService>
  resources?: Registration<ResourceResolver>
  tokens: Set<object>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    ai: AiService
  }
}
export class AiService extends Service<Config> {
  private readonly agents = new Registry<AgentPreset>((entry) => this.removed(entry))
  private readonly agentDefinitions = new Registry<AgentDefinition>((entry) => this.removed(entry))
  private readonly providers = new Registry<Provider>((entry) => this.removed(entry))
  private readonly drivers = new Registry<ModelDriver>((entry) => this.removed(entry))
  private readonly backends = new Registry<ExecutionBackend>((entry) => this.removed(entry))
  private readonly tools = new Registry<Tool>((entry) => this.removed(entry), true)
  private readonly extensions = new Registry<Extension>((entry) => this.removed(entry))
  private skills = new Registry<SkillService>((entry) => this.removed(entry))
  private resources = new Registry<ResourceResolver>((entry) => this.removed(entry))
  private accesses = new WeakMap<Access, { source: string; request: unknown }>()
  readonly running = new Map<string, Running>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  readonly config: Config
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ai')
    this.config = config
    ctx.rbac.registerPermission(ctx, 'ai.chat.use', '使用 AI 对话', ['user', 'admin'])
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.all([...this.running.values()].map((run) => run.cancel()))
      await this.queue
    })
  }
  get context() {
    return this.ctx
  }
  private db() {
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.catch(() => {})
    return result
  }
  private async removed(entry: { token: object }) {
    await Promise.all(
      [...this.running.values()]
        .filter((run) => run.bound.tokens.has(entry.token))
        .map((run) => run.cancel()),
    )
  }
  private notifyConversation(conversation: Conversation) {
    void this.ctx
      .parallel('ai/conversation', freeze(json(conversation)))
      .catch(() => this.ctx.logger.warn('对话状态通知监听器执行失败'))
  }
  private active() {
    check(!this.closing, 'AI 服务已卸载')
    this.ctx.fiber.assertActive()
  }
  registerAgent(owner: Context, value: AgentPreset) {
    this.active()
    check(!this.agentDefinitions.list().some((entry) => entry.id === value.id), 'Agent ID 已存在')
    validateAgent(value)
    check(
      value.models.length > 0 &&
        value.models.some((model) => canonical(model) === canonical(value.defaultModel)),
      '默认模型必须属于允许列表',
    )
    check(!value.toolIds.includes('use_skill'), 'use_skill 只能由 Skill 服务提供')
    identifier(value.version)
    return this.agents.register(owner, value.id, freeze(json(value)))
  }
  registerAgentDefinition(owner: Context, value: AgentDefinition) {
    this.active()
    check(!this.agents.list().some((entry) => entry.id === value.id), 'Agent ID 已存在')
    check(
      !value.isDefault || !this.agentDefinitions.list().some((entry) => entry.isDefault),
      '默认 Agent 已存在',
    )
    return this.agentDefinitions.register(owner, value.id, Object.freeze({ ...value }))
  }
  get defaultAgentId() {
    return this.agentDefinitions.list().find((entry) => entry.isDefault)?.id ?? null
  }
  /** 仅包含公开能力元数据，不包含连接地址、凭据或执行函数。 */
  capabilities() {
    this.active()
    return json({
      providers: this.providers.list().map((p) => ({ id: p.id, title: p.title, models: p.models })),
      tools: [
        ...this.tools.list().map((t) => ({ id: t.id, description: t.description })),
        ...this.providers.list().flatMap((p) =>
          (p.builtinTools ?? []).map((t) => ({
            id: t.id,
            description: `${p.title} · ${t.description}（提供商内部执行）`,
          })),
        ),
      ],
      backends: this.backends.list().map((b) => b.id),
      skillsAvailable: this.skills.list().length > 0,
    })
  }
  private resolvedAgent(id: string): Registration<AgentPreset> {
    if (this.agents.list().some((entry) => entry.id === id)) return this.agents.get(id)
    const entry = this.agentDefinitions.get(id)
    const value = entry.value.resolve()
    if (!value)
      throw new AiError('capability_unavailable', 'Agent 暂无可用模型，请在管理控制台配置模型', 503)
    validateAgent(value)
    check(
      value.id === id &&
        value.models.some((model) => canonical(model) === canonical(value.defaultModel)),
      'Agent 默认模型无效',
    )
    check(!value.toolIds.includes('use_skill'), 'use_skill 只能由 Skill 服务提供')
    return { ...entry, value: freeze(json(value)) }
  }
  registerProvider(owner: Context, value: Provider) {
    this.active()
    check(
      new Set(value.models.map((model) => model.id)).size === value.models.length,
      '模型 ID 重复',
    )
    for (const model of value.models) {
      identifier(model.id)
      check(
        Number.isSafeInteger(model.contextWindow) &&
          model.contextWindow > 0 &&
          Number.isSafeInteger(model.maxOutputTokens) &&
          model.maxOutputTokens > 0,
        '模型限制无效',
      )
    }
    if (value.idleTimeoutMs !== undefined)
      check(Number.isSafeInteger(value.idleTimeoutMs) && value.idleTimeoutMs > 0, '无活动时限无效')
    return this.providers.register(
      owner,
      value.id,
      Object.freeze({
        ...value,
        models: freeze(json(value.models)),
        ...(value.builtinTools ? { builtinTools: freeze(json(value.builtinTools)) } : {}),
      }),
    )
  }
  registerDriver(owner: Context, value: ModelDriver) {
    this.active()
    if (value.parameters) compile(value.parameters)
    return this.drivers.register(owner, value.id, Object.freeze({ ...value }))
  }
  registerBackend(owner: Context, value: ExecutionBackend) {
    this.active()
    return this.backends.register(owner, value.id, Object.freeze({ ...value }))
  }
  registerTool(owner: Context, value: Tool) {
    this.active()
    check(value.id !== 'use_skill', 'use_skill 为保留工具')
    this.validateTool(value)
    return this.tools.register(
      owner,
      value.id,
      Object.freeze({ ...value, parameters: freeze(json(value.parameters)) }),
    )
  }
  validateTool(value: Tool) {
    identifier(value.id)
    compile(value.parameters)
    check(
      value.timeoutMs === undefined ||
        value.timeoutMs === null ||
        (Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0),
      '工具超时无效',
    )
  }
  registerSkills(owner: Context, value: SkillService) {
    this.active()
    return this.skills.register(owner, 'skills', value)
  }
  registerResources(owner: Context, value: ResourceResolver) {
    this.active()
    return this.resources.register(owner, 'resources', value)
  }
  registerExtension(owner: Context, value: Extension) {
    this.active()
    compile(value.schema)
    const extension = Object.freeze({ ...value, schema: freeze(json(value.schema)) })
    const dispose = this.extensions.register(owner, value.id, extension)
    // 准备回调同样进入 Cordis 的事件链，不另建扩展回调分发机制。
    const off = owner.on('ai/prepare', (context) => {
      if (!Object.hasOwn(context.agent.extensions, extension.id)) return
      const config = context.agent.extensions[extension.id]
      if (config && extension.prepare) return extension.prepare(context, config)
    })
    return owner.effect(() => async () => {
      off()
      await dispose()
    })
  }
  async authorize(source: string, request: unknown): Promise<Access> {
    this.active()
    const identity = await this.ctx.rbac.authorizeRequest(source, request, 'ai.chat.use')
    check(identity.actorId && identity.workspaceId, '身份或空间未解析')
    const access = Object.freeze({ actorId: identity.actorId, workspaceId: identity.workspaceId })
    this.accesses.set(access, { source, request })
    return access
  }
  async verify(access: Access): Promise<RequestAccess> {
    this.active()
    const source = this.accesses.get(access)
    if (!source) throw new AiError('forbidden', '访问上下文未经认证', 403)
    const current = await this.ctx.rbac.authorizeRequest(
      source.source,
      source.request,
      'ai.chat.use',
    )
    if (current.actorId !== access.actorId || current.workspaceId !== access.workspaceId)
      throw new AiError('forbidden', '身份或空间已变化', 403)
    return current
  }
  async catalog(access: Access) {
    await this.verify(access)
    return json({
      agents: [
        ...this.agents.list(),
        ...this.agentDefinitions.list().flatMap((entry) => {
          const value = entry.resolve()
          return value ? [value] : []
        }),
      ],
      defaultAgentId: this.defaultAgentId,
      providers: this.providers.list().map((p) => ({ id: p.id, title: p.title, models: p.models })),
      tools: this.tools
        .list()
        .map((t) => ({ id: t.id, description: t.description, parameters: t.parameters })),
    })
  }
  async createConversation(access: Access, agentId?: string, title = '') {
    await this.verify(access)
    agentId ??= this.defaultAgentId ?? undefined
    if (!agentId) throw new AiError('capability_unavailable', '尚未配置默认 Agent', 503)
    if (!this.agentDefinitions.list().some((entry) => entry.id === agentId))
      this.agents.get(agentId)
    check(typeof title === 'string' && title.length <= 200, '标题无效')
    const value: Conversation = {
      id: randomUUID(),
      agentId,
      title,
      ...access,
      revision: 0,
      selectedNodeId: null,
      activeRunId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      archivedAt: null,
    }
    await this.locked(async () => {
      await this.db()
        .insertInto('conversations')
        .values({ ...row(value, access.workspaceId), ...conversationFields(value) })
        .execute()
      this.notifyConversation(value)
    })
    return value
  }
  async listConversations(access: Access, offset = 0, limit = 50, archived = false) {
    await this.verify(access)
    check(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 100,
      '分页参数无效',
    )
    return (
      await this.db()
        .selectFrom('conversations')
        .selectAll()
        .where('workspace_id', '=', access.workspaceId)
        .where('archived_at', archived ? 'is not' : 'is', null)
        .orderBy('last_activity_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute()
    ).map(decode<Conversation>)
  }
  async updateConversation(
    access: Access,
    id: string,
    changes: { title?: string; archived?: boolean },
  ) {
    await this.verify(access)
    check(changes.title !== undefined || changes.archived !== undefined, '缺少会话更新内容')
    if (changes.title !== undefined)
      check(
        typeof changes.title === 'string' &&
          changes.title.trim().length > 0 &&
          changes.title.trim().length <= 200,
        '标题须为 1–200 个字符',
      )
    check(changes.archived === undefined || typeof changes.archived === 'boolean', '归档状态无效')
    return this.locked(async () => {
      const conversation = await this.conversation(access, id)
      if (changes.archived === true && conversation.activeRunId)
        throw new AiError('busy', '请等待生成结束后归档', 409)
      if (changes.title !== undefined) conversation.title = changes.title.trim()
      if (changes.archived !== undefined)
        conversation.archivedAt = changes.archived ? (conversation.archivedAt ?? Date.now()) : null
      conversation.revision++
      await this.db()
        .updateTable('conversations')
        .set(conversationFields(conversation))
        .where('id', '=', id)
        .execute()
      this.notifyConversation(conversation)
      return conversation
    })
  }
  /** 只接受核心签发的正在执行的工具上下文，更新在会话队列内原子完成。 */
  async updateRunConversation(
    context: RunContext,
    update: (conversation: Readonly<Conversation>) => {
      title?: string
      todos?: ConversationTodo[]
    },
  ) {
    const live = this.running.get(context.runId)
    const assertContext = () => {
      if (!live || live.record.status !== 'running' || !live.ownsToolContext(context))
        throw new AiError('forbidden', '工具运行上下文已失效', 403)
    }
    assertContext()
    await this.verify(live!.access)
    return this.locked(async () => {
      assertContext()
      const conversation = await this.conversation(live!.access, context.conversationId)
      check(conversation.activeRunId === context.runId, '工具不属于当前会话运行')
      const changes = update(freeze(json(conversation)))
      if (changes.title !== undefined) {
        check(
          typeof changes.title === 'string' &&
            changes.title.trim().length > 0 &&
            changes.title.trim().length <= 200,
          '标题须为 1–200 个字符',
        )
        conversation.title = changes.title.trim()
      }
      if (changes.todos !== undefined) {
        const todos = changes.todos
        check(Array.isArray(todos) && todos.length <= 100, '待办列表最多 100 项')
        check(
          todos.every(
            (item) =>
              item &&
              typeof item.id === 'string' &&
              item.id.trim().length > 0 &&
              item.id.length <= 100 &&
              typeof item.text === 'string' &&
              item.text.trim().length > 0 &&
              item.text.length <= 500 &&
              ['pending', 'in_progress', 'completed'].includes(item.status),
          ) && new Set(todos.map((item) => item.id)).size === todos.length,
          '待办项的标识、内容或状态无效',
        )
        conversation.todos = json(todos)
      }
      check(changes.title !== undefined || changes.todos !== undefined, '缺少会话更新内容')
      assertContext()
      conversation.revision++
      await this.db()
        .updateTable('conversations')
        .set(conversationFields(conversation))
        .where('id', '=', conversation.id)
        .where('workspace_id', '=', context.workspaceId)
        .execute()
      this.notifyConversation(conversation)
      return json(conversation)
    })
  }
  async backfillHistory() {
    await this.db().transaction(async (db) => {
      const rows = await db
        .selectFrom('conversations')
        .selectAll()
        .where('last_activity_at', 'is', null)
        .execute()
      for (const existing of rows) {
        const conversation = decode<Conversation>(existing)
        const runs = await db
          .selectFrom('runs')
          .selectAll()
          .where('conversation_id', '=', conversation.id)
          .execute()
        conversation.lastActivityAt = runs.reduce((time, item) => {
          const run = decode<RunRecord>(item)
          return Math.max(time, run.createdAt, run.endedAt ?? 0)
        }, conversation.createdAt)
        conversation.archivedAt ??= null
        await db
          .updateTable('conversations')
          .set(conversationFields(conversation))
          .where('id', '=', conversation.id)
          .execute()
      }
    })
  }
  private async conversation(access: Access, id: string) {
    const result = await this.db()
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', id)
      .where('workspace_id', '=', access.workspaceId)
      .executeTakeFirst()
    if (!result) throw new AiError('not_found', '会话不存在', 404)
    return decode<Conversation>(result)
  }
  private async nodes(id: string) {
    return (
      await this.db().selectFrom('nodes').selectAll().where('conversation_id', '=', id).execute()
    ).map(decode<MessageNode>)
  }
  async getConversation(access: Access, id: string) {
    await this.verify(access)
    return this.locked(async () => {
      const conversation = await this.conversation(access, id)
      const nodes = await this.nodes(id)
      nodes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      for (const node of nodes) {
        const siblings = nodes.filter((n) => n.parentId === node.parentId && n.role === node.role)
        node.versionCount = siblings.length
      }
      const path: MessageNode[] = []
      let cursor = conversation.selectedNodeId
      while (cursor) {
        const node = nodes.find((n) => n.id === cursor)!
        path.unshift(node)
        cursor = node.parentId
      }
      return { conversation, nodes, path }
    })
  }
  private expected(conversation: Conversation, revision: number, nodeId: string | null) {
    if (conversation.activeRunId) throw new AiError('busy', '会话正在运行', 409)
    if (conversation.revision !== revision || conversation.selectedNodeId !== nodeId)
      throw new AiError('conflict', '会话版本已变化', 409)
  }
  async select(
    access: Access,
    id: string,
    expectedRevision: number,
    expectedNodeId: string | null,
    nodeId: string | null,
  ) {
    await this.verify(access)
    return this.locked(async () => {
      const conversation = await this.conversation(access, id)
      this.expected(conversation, expectedRevision, expectedNodeId)
      check(
        nodeId === null || (await this.nodes(id)).some((node) => node.id === nodeId),
        '节点不属于会话',
      )
      conversation.selectedNodeId = nodeId
      conversation.revision++
      await this.db()
        .updateTable('conversations')
        .set(conversationFields(conversation))
        .where('id', '=', id)
        .execute()
      this.notifyConversation(conversation)
      return conversation
    })
  }
  async getRun(access: Access, id: string) {
    await this.verify(access)
    const result = await this.db()
      .selectFrom('runs')
      .selectAll()
      .where('id', '=', id)
      .where('workspace_id', '=', access.workspaceId)
      .executeTakeFirst()
    if (!result) throw new AiError('not_found', '运行不存在', 404)
    return decode<RunRecord>(result)
  }
  async events(access: Access, id: string, after = 0, limit = 100) {
    await this.getRun(access, id)
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 100,
      '事件游标无效',
    )
    return (
      await this.db()
        .selectFrom('events')
        .selectAll()
        .where('run_id', '=', id)
        .where('sequence', '>', after)
        .orderBy('sequence')
        .limit(limit)
        .execute()
    ).map(decode<AiEvent>)
  }
  async cancel(access: Access, id: string) {
    await this.getRun(access, id)
    await this.running.get(id)?.cancel()
    return this.getRun(access, id)
  }
  private bind(agentId: string): Bound {
    const agent = this.resolvedAgent(agentId)
    const bound: Bound = {
      agent,
      backend: this.backends.get(agent.value.backendId),
      providers: new Map(),
      drivers: new Map(),
      tools: new Map(),
      extensions: [],
      tokens: new Set(),
    }
    for (const ref of agent.value.models) {
      const provider = this.providers.get(ref.providerId)
      check(
        provider.value.models.some((m) => m.id === ref.modelId),
        'Agent 引用的模型不存在',
      )
      bound.providers.set(ref.providerId, provider)
      bound.drivers.set(provider.value.driverId, this.drivers.get(provider.value.driverId))
    }
    const builtinIds = new Set(
      this.providers.list().flatMap((p) => (p.builtinTools ?? []).map((t) => t.id)),
    )
    for (const id of agent.value.toolIds) {
      if (!builtinIds.has(id)) bound.tools.set(id, this.tools.get(id))
    }
    for (const [id, config] of Object.entries(agent.value.extensions)) {
      const extension = this.extensions.get(id)
      compile(extension.value.schema)(config)
      bound.extensions.push(extension)
    }
    if (agent.value.skillIds === null || agent.value.skillIds.length)
      bound.skill = this.skills.get('skills')
    if (this.resources.list().length) bound.resources = this.resources.get('resources')
    for (const item of [
      agent,
      bound.backend,
      ...bound.providers.values(),
      ...bound.drivers.values(),
      ...bound.tools.values(),
      ...bound.extensions,
      bound.skill,
      bound.resources,
    ])
      if (item) bound.tokens.add(item.token)
    return bound
  }
  async start(access: Access, id: string, command: RunCommand): Promise<RunRecord> {
    await this.verify(access)
    validateCommand(command)
    identifier(command.idempotencyKey)
    check(['send', 'edit', 'regenerate'].includes(command.operation), '运行操作无效')
    const fingerprint = canonical(command)
    return this.locked(async () => {
      const conversation = await this.conversation(access, id)
      const prior = await this.db()
        .selectFrom('runs')
        .selectAll()
        .where('conversation_id', '=', id)
        .where('request_key', '=', command.idempotencyKey)
        .executeTakeFirst()
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AiError('conflict', '幂等键参数不一致', 409)
        return decode<RunRecord>(prior)
      }
      if (conversation.archivedAt !== null)
        throw new AiError('archived', '请先取消归档再继续对话', 409)
      this.expected(conversation, command.expectedRevision, command.expectedNodeId)
      const bound = this.bind(conversation.agentId)
      const nodes = await this.nodes(id)
      const target = nodes.find((n) => n.id === command.targetNodeId)
      let parentId = conversation.selectedNodeId
      let input: UserInput | undefined = command.input
      let user: MessageNode | undefined
      if (command.operation === 'edit') {
        check(target?.role === 'user', '编辑目标必须是用户消息')
        parentId = target.parentId
      }
      if (command.operation === 'regenerate') {
        check(target, '重新生成目标不存在')
        user = target.role === 'user' ? target : nodes.find((n) => n.id === target.parentId)
        check(user?.role === 'user' && user.input, '重新生成缺少用户输入')
        input = user.input
        parentId = user.parentId
      }
      check(input && typeof input.text === 'string', '缺少用户输入')
      check(
        !input.variables ||
          (typeof input.variables === 'object' && !Array.isArray(input.variables)),
        '变量必须是对象',
      )
      check(!input.attachments || Array.isArray(input.attachments), '附件必须是数组')
      const history: RunRecord[] = []
      let cursor = parentId
      while (cursor) {
        const node = nodes.find((n) => n.id === cursor)
        check(node, '历史节点不存在')
        if (node.role === 'assistant') {
          const record = await this.db()
            .selectFrom('runs')
            .selectAll()
            .where('id', '=', node.runId)
            .executeTakeFirstOrThrow()
          const previous = decode<RunRecord>(record)
          check(previous.status === 'completed', '未完成轮次须重试或切换到完整节点')
          history.unshift(previous)
        } else
          check(
            history.some((run) => run.userNodeId === node.id),
            '不能直接续写未回复的用户消息',
          )
        cursor = node.parentId
      }
      const agent = json(bound.agent.value)
      const model = command.model ?? agent.defaultModel
      check(
        agent.models.some((m) => canonical(m) === canonical(model)),
        '模型不在 Agent 允许列表',
      )
      const runId = randomUUID()
      if (!user)
        user = {
          id: randomUUID(),
          conversationId: id,
          parentId,
          runId,
          role: 'user',
          content: [{ type: 'text', text: input.text }, ...(input.attachments ?? [])],
          input: json(input),
          createdAt: Date.now(),
          version: 1,
          versionCount: 1,
        }
      const reply: MessageNode = {
        id: randomUUID(),
        conversationId: id,
        parentId: user.id,
        runId,
        role: 'assistant',
        content: [],
        createdAt: Date.now(),
        version: 1,
        versionCount: 1,
      }
      if (command.operation !== 'regenerate')
        user.version =
          nodes.filter((node) => node.role === 'user' && node.parentId === user.parentId).length + 1
      reply.version =
        nodes.filter((node) => node.role === 'assistant' && node.parentId === user.id).length + 1
      const run: RunRecord = {
        id: runId,
        conversationId: id,
        workspaceId: access.workspaceId,
        actorId: access.actorId,
        userNodeId: user.id,
        replyNodeId: reply.id,
        status: 'running',
        agent,
        model: json(model),
        thinking:
          command.thinking === undefined ? (agent.defaultThinking ?? null) : command.thinking,
        input: json(input),
        messages: [],
        requests: [],
        error: null,
        createdAt: Date.now(),
        endedAt: null,
      }
      const live = new Running(
        this,
        run,
        bound,
        history.flatMap((item) => item.messages),
        access,
      )
      live.validateSelection(model, run.thinking)
      conversation.lastActivityAt = run.createdAt
      conversation.activeRunId = runId
      conversation.selectedNodeId = reply.id
      conversation.revision++
      await this.db().transaction(async (db) => {
        if (command.operation !== 'regenerate')
          await db.insertInto('nodes').values(row(user!, access.workspaceId)).execute()
        await db.insertInto('nodes').values(row(reply, access.workspaceId)).execute()
        await db
          .insertInto('runs')
          .values({
            ...row(run, access.workspaceId),
            request_key: command.idempotencyKey,
            fingerprint,
            status: run.status,
          })
          .execute()
        await db
          .updateTable('conversations')
          .set(conversationFields(conversation))
          .where('id', '=', id)
          .execute()
      })
      this.running.set(runId, live)
      this.notifyConversation(conversation)
      live.start()
      return json(run)
    })
  }
  async persist(live: Running, type: AiEvent['type'], data: unknown) {
    return this.locked(async () => {
      const event: AiEvent = {
        runId: live.record.id,
        conversationId: live.record.conversationId,
        workspaceId: live.record.workspaceId,
        sequence: live.sequence + 1,
        type,
        data: payload(data),
        createdAt: Date.now(),
      }
      let changedConversation: Conversation | undefined
      await this.db().transaction(async (db) => {
        await saveRun(db, live.record)
        const existing = await db
          .selectFrom('nodes')
          .selectAll()
          .where('id', '=', live.record.replyNodeId)
          .executeTakeFirstOrThrow()
        const node = decode<MessageNode>(existing)
        node.content = json(live.reply)
        await db
          .updateTable('nodes')
          .set({ payload: JSON.stringify(node) })
          .where('id', '=', node.id)
          .execute()
        await appendEvent(db, event)
        if (type === 'run-end') {
          const existingConversation = await db
            .selectFrom('conversations')
            .selectAll()
            .where('id', '=', live.record.conversationId)
            .executeTakeFirstOrThrow()
          const conversation = decode<Conversation>(existingConversation)
          conversation.lastActivityAt = live.record.endedAt ?? Date.now()
          conversation.activeRunId = null
          conversation.revision++
          changedConversation = conversation
          await db
            .updateTable('conversations')
            .set(conversationFields(conversation))
            .where('id', '=', conversation.id)
            .execute()
        }
      })
      live.sequence = event.sequence
      if (changedConversation) this.notifyConversation(changedConversation)
      // 通知不阻塞数据库串行队列，监听器可安全调用核心读取接口。
      void this.ctx
        .parallel('ai/event', freeze(json(event)), freeze(json(live.record.agent)))
        .catch(() => this.ctx.logger.warn('AI 通知监听器执行失败'))
    })
  }
  async recover() {
    await this.db().transaction(async (db) => {
      for (const existing of await db
        .selectFrom('runs')
        .selectAll()
        .where('status', '=', 'running')
        .execute()) {
        const run = decode<RunRecord>(existing)
        run.status = 'interrupted'
        run.endedAt = Date.now()
        run.error = { code: 'interrupted', message: '服务重启，运行已中断' }
        await saveRun(db, run)
        const last = await db
          .selectFrom('events')
          .select('sequence')
          .where('run_id', '=', run.id)
          .orderBy('sequence', 'desc')
          .executeTakeFirst()
        await appendEvent(db, {
          runId: run.id,
          conversationId: run.conversationId,
          workspaceId: run.workspaceId,
          sequence: (last?.sequence ?? 0) + 1,
          type: 'run-end',
          data: { status: run.status },
          createdAt: Date.now(),
        })
        const existingConversation = await db
          .selectFrom('conversations')
          .selectAll()
          .where('id', '=', run.conversationId)
          .executeTakeFirstOrThrow()
        const conversation = decode<Conversation>(existingConversation)
        conversation.activeRunId = null
        conversation.lastActivityAt = run.endedAt
        conversation.revision++
        await db
          .updateTable('conversations')
          .set(conversationFields(conversation))
          .where('id', '=', conversation.id)
          .execute()
      }
    })
  }
}
export default defineDatabasePlugin<Partial<Config>>({
  name: pluginId,
  migrations,
  inject: ['rbac', 'server'],
  async apply(ctx, input) {
    const config = schemaConfig<Config>(
      new URL('../config.schema.json', import.meta.url),
      input ?? {},
    )
    await ctx.plugin(AiService, config)
    await ctx.plugin({
      inject: ['ai', 'server', 'rbac'],
      async apply(ctx: Context) {
        await ctx.ai.backfillHistory()
        await ctx.ai.recover()
        routes(ctx)
      },
    })
  },
})
