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
  MessageNode,
  RunCommand,
  RunRecord,
  UserInput,
} from '@antarestra/contracts'
import type {
  Config,
  ExecutionBackend,
  Extension,
  ModelDriver,
  Provider,
  Registration,
  ResourceResolver,
  SkillService,
  Tool,
} from './types.js'
import { Registry } from './registry.js'
import { appendEvent, decode, migrations, pluginId, row, saveRun } from './store.js'
import type { Tables } from './store.js'
import { AiError, canonical, check, compile, freeze, identifier, json, payload } from './utils.js'
import { Running } from './runtime.js'
import { routes } from './http.js'
import { validateAgent, validateCommand } from './validation.js'
export * from './types.js'
export { AiError } from './utils.js'
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
  private active() {
    check(!this.closing, 'AI 服务已卸载')
    this.ctx.fiber.assertActive()
  }
  registerAgent(owner: Context, value: AgentPreset) {
    this.active()
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
      Object.freeze({ ...value, models: freeze(json(value.models)) }),
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
      agents: this.agents.list(),
      providers: this.providers.list().map((p) => ({ id: p.id, title: p.title, models: p.models })),
      tools: this.tools
        .list()
        .map((t) => ({ id: t.id, description: t.description, parameters: t.parameters })),
    })
  }
  async createConversation(access: Access, agentId: string, title = '') {
    await this.verify(access)
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
    }
    await this.locked(async () => {
      await this.db().insertInto('conversations').values(row(value, access.workspaceId)).execute()
    })
    return value
  }
  async listConversations(access: Access, offset = 0, limit = 50) {
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
        .orderBy('id')
        .offset(offset)
        .limit(limit)
        .execute()
    ).map(decode<Conversation>)
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
        .set({ payload: JSON.stringify(conversation) })
        .where('id', '=', id)
        .execute()
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
    const agent = this.agents.get(agentId)
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
    for (const id of agent.value.toolIds) bound.tools.set(id, this.tools.get(id))
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
        thinking: command.thinking ?? agent.defaultThinking ?? null,
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
      )
      live.validateSelection(model, run.thinking)
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
          .set({ payload: JSON.stringify(conversation) })
          .where('id', '=', id)
          .execute()
      })
      this.running.set(runId, live)
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
          conversation.activeRunId = null
          conversation.revision++
          await db
            .updateTable('conversations')
            .set({ payload: JSON.stringify(conversation) })
            .where('id', '=', conversation.id)
            .execute()
        }
      })
      live.sequence = event.sequence
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
        conversation.revision++
        await db
          .updateTable('conversations')
          .set({ payload: JSON.stringify(conversation) })
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
        await ctx.ai.recover()
        routes(ctx)
      },
    })
  },
})
