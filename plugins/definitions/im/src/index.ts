import { createHash } from 'node:crypto'
import { Service, type Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { migrations, pluginId, type Tables } from './schema.js'
import type {
  ChatPolicy,
  ChatTarget,
  ConnectionDescriptor,
  ConnectionHandle,
  ConnectionPolicy,
  ConnectionSnapshot,
  IdentityInput,
  IdentityResolver,
  ImIdentity,
  IncomingMessage,
  MessageContext,
  MessageHandler,
  MessageSegment,
  ScopedTarget,
} from './types.js'
export * from './types.js'
export interface Config {}
export class ImError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function validateConnectionPolicy(policy: unknown): ConnectionPolicy {
  try {
    return schemaConfig<ConnectionPolicy>(new URL('../policy.schema.json', import.meta.url), policy)
  } catch {
    throw new ImError(400, 'invalid_policy', 'IM 策略格式无效')
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const connectionKey = (
  c: Pick<ConnectionDescriptor, 'id' | 'platform' | 'accountId' | 'tenantId'>,
) => hash([c.id, c.platform, c.tenantId ?? '', c.accountId])
interface Entry {
  descriptor: ConnectionDescriptor
  snapshot: ConnectionSnapshot
  controller: AbortController
  policy: ConnectionPolicy
  pending: Set<Promise<unknown>>
}
interface Trusted {
  entry: Entry
  identity: ImIdentity
  input: IdentityInput
  resolver: IdentityResolver
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    im: ImService
  }
}

interface ServiceOptions {
  config: Config
  policies: Tables['policy'][]
}
export class ImService extends Service<ServiceOptions> {
  private readonly connections = new Map<string, Entry>()
  private readonly handlers = new Map<string, MessageHandler>()
  private readonly handlerWork = new Map<
    MessageHandler,
    { controller: AbortController; pending: Set<Promise<unknown>> }
  >()
  private readonly requests = new WeakMap<object, Trusted>()
  private resolver: IdentityResolver | undefined
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly saved = new Map<string, ConnectionPolicy>()
  private readonly revisions = new Map<string, number>()
  constructor(ctx: Context, options: ServiceOptions) {
    super(ctx, 'im')
    schemaConfig(new URL('../config.schema.json', import.meta.url), options.config)
    for (const row of options.policies) {
      this.saved.set(row.id, validateConnectionPolicy(JSON.parse(row.value)))
      this.revisions.set(row.id, row.revision)
    }
    ctx.effect(() => async () => {
      const pending = [...this.connections.values()].flatMap((entry) => [...entry.pending])
      for (const entry of this.connections.values()) entry.controller.abort()
      for (const entry of this.handlerWork.values()) entry.controller.abort()
      this.connections.clear()
      this.handlers.clear()
      this.resolver = undefined
      await Promise.allSettled(pending)
    })
  }
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  private assertEntry(entry: Entry) {
    this.ctx.fiber.assertActive()
    if (this.connections.get(entry.descriptor.id) !== entry || entry.controller.signal.aborted)
      throw new Error('IM 接入已卸载')
  }
  registerConnection(owner: Context, descriptor: ConnectionDescriptor): ConnectionHandle {
    this.ctx.fiber.assertActive()
    descriptor = { ...descriptor, policy: validateConnectionPolicy(descriptor.policy ?? {}) }
    if (!descriptor.id || !descriptor.accountId || !descriptor.platform)
      throw new Error('IM 接入标识不能为空')
    if (this.connections.has(descriptor.id)) throw new Error('IM 接入标识重复')
    const entry: Entry = {
      descriptor: { ...descriptor },
      snapshot: {
        id: descriptor.id,
        platform: descriptor.platform,
        accountId: descriptor.accountId,
        ...(descriptor.tenantId ? { tenantId: descriptor.tenantId } : {}),
        ...(descriptor.label ? { label: descriptor.label } : {}),
        capabilities: [...(descriptor.capabilities ?? [])],
        status: 'connecting',
      },
      controller: new AbortController(),
      pending: new Set(),
      policy: structuredClone(this.saved.get(connectionKey(descriptor)) ?? descriptor.policy ?? {}),
    }
    owner.effect(() => {
      this.connections.set(descriptor.id, entry)
      return async () => {
        entry.controller.abort()
        if (this.connections.get(descriptor.id) === entry) this.connections.delete(descriptor.id)
        await Promise.allSettled([...entry.pending])
      }
    })
    return {
      receive: (message) => {
        const work = this.receive(entry, message)
        entry.pending.add(work)
        void work.then(
          () => entry.pending.delete(work),
          () => entry.pending.delete(work),
        )
        return work
      },
      setStatus: (status, error) => {
        this.assertEntry(entry)
        entry.snapshot = { ...entry.snapshot, status, ...(error ? { error } : {}) }
        if (!error) delete entry.snapshot.error
      },
    }
  }
  registerIdentity(owner: Context, resolver: IdentityResolver) {
    this.ctx.fiber.assertActive()
    if (this.resolver) throw new Error('IM 身份解析器重复注册')
    return owner.effect(() => {
      this.resolver = resolver
      return () => {
        if (this.resolver === resolver) this.resolver = undefined
      }
    })
  }
  registerHandler(owner: Context, handler: MessageHandler) {
    this.ctx.fiber.assertActive()
    if (this.handlers.has(handler.id)) throw new Error('IM 消息处理器重复注册')
    const work = { controller: new AbortController(), pending: new Set<Promise<unknown>>() }
    return owner.effect(() => {
      this.handlers.set(handler.id, handler)
      this.handlerWork.set(handler, work)
      return async () => {
        work.controller.abort()
        if (this.handlers.get(handler.id) === handler) this.handlers.delete(handler.id)
        await Promise.allSettled([...work.pending])
        this.handlerWork.delete(handler)
      }
    })
  }
  listConnections(): ConnectionSnapshot[] {
    return [...this.connections.values()].map((entry) => structuredClone(entry.snapshot))
  }
  getPolicy(connectionId: string): ConnectionPolicy {
    return structuredClone(this.entry(connectionId).policy)
  }
  getPolicyRevision(connectionId: string): number {
    return this.revisions.get(connectionKey(this.entry(connectionId).descriptor)) ?? 0
  }
  async setPolicy(
    connectionId: string,
    policy: ConnectionPolicy,
    expectedRevision?: number,
  ): Promise<void> {
    const entry = this.entry(connectionId)
    const copy = validateConnectionPolicy(policy),
      id = connectionKey(entry.descriptor)
    await this.exclusive(`policy:${id}`, async () => {
      const revision = this.revisions.get(id) ?? 0
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new ImError(409, 'revision_conflict', 'IM 策略已被其他操作修改，请刷新后重试')
      await this.db().transaction(async (db) => {
        await db.deleteFrom('policy').where('id', '=', id).execute()
        await db
          .insertInto('policy')
          .values({ id, value: JSON.stringify(copy), revision: revision + 1 })
          .execute()
      })
      this.assertEntry(entry)
      entry.policy = copy
      this.saved.set(id, copy)
      this.revisions.set(id, revision + 1)
    })
  }
  getChatPolicy(connectionId: string, chat: ChatTarget): Readonly<ChatPolicy> {
    const entry = this.entry(connectionId),
      policy = entry.policy,
      access = policy[chat.type]
    const admits = (p: ConnectionPolicy) => {
      const a = p[chat.type]
      return (
        p.enabled !== false &&
        !!a &&
        (a.mode === 'whitelist'
          ? a.ids.includes(chat.id)
          : a.mode === 'blacklist' && !a.ids.includes(chat.id))
      )
    }
    const allowed = admits(policy) && admits(entry.descriptor.policy ?? {})
    const merged = {
      commands: true,
      ai: false,
      ...policy.defaults,
      ...access?.defaults,
      ...policy.chats?.[`${chat.type}:${chat.id}`],
    }
    return Object.freeze({
      ...structuredClone(merged),
      enabled: allowed && merged.enabled !== false,
    })
  }
  private entry(id: string) {
    const entry = this.connections.get(id)
    if (!entry) throw new Error('IM 接入不可用')
    this.assertEntry(entry)
    return entry
  }
  private async exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    this.locks.set(key, current)
    try {
      return await current
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key)
    }
  }
  async authenticate(request: unknown): Promise<ImIdentity | undefined> {
    if (!request || typeof request !== 'object') return
    const trusted = this.requests.get(request)
    if (
      !trusted ||
      this.resolver !== trusted.resolver ||
      this.connections.get(trusted.entry.descriptor.id) !== trusted.entry ||
      trusted.entry.controller.signal.aborted
    )
      return
    if (!this.getChatPolicy(trusted.entry.descriptor.id, trusted.input.message.chat).enabled) return
    if (!(await trusted.resolver.validate(trusted.identity, trusted.input))) return
    if (
      this.resolver !== trusted.resolver ||
      trusted.entry.controller.signal.aborted ||
      !this.getChatPolicy(trusted.entry.descriptor.id, trusted.input.message.chat).enabled
    )
      return
    return { ...trusted.identity }
  }
  async validateBackground(actorId: string, workspaceId: string): Promise<ImIdentity | undefined> {
    const resolver = this.resolver
    const resolved = await resolver?.background(actorId, workspaceId)
    if (!resolved || !resolver || this.resolver !== resolver) return
    const entry = this.connections.get(resolved.input.connection.id)
    if (
      !entry ||
      connectionKey(entry.descriptor) !== connectionKey(resolved.input.connection) ||
      !this.getChatPolicy(entry.descriptor.id, resolved.input.message.chat).enabled ||
      !entry.descriptor.getMember
    )
      return
    const member = await entry.descriptor.getMember(
      resolved.input.message.chat,
      resolved.input.message.sender.id,
    )
    if (
      !member.active ||
      this.resolver !== resolver ||
      entry.controller.signal.aborted ||
      !(await resolver.validate(resolved.identity, resolved.input)) ||
      !this.getChatPolicy(entry.descriptor.id, resolved.input.message.chat).enabled
    )
      return
    return resolved.identity
  }
  private async receive(
    entry: Entry,
    original: IncomingMessage,
  ): Promise<{ status: 'processed' | 'duplicate' | 'ignored' }> {
    this.assertEntry(entry)
    const message = structuredClone(original)
    if (
      !message.id ||
      !message.sender.id ||
      !message.chat.id ||
      !['private', 'group'].includes(message.chat.type)
    )
      throw new Error('IM 消息标识无效')
    if (
      message.sender.id === entry.descriptor.accountId ||
      message.sender.bot ||
      !this.getChatPolicy(entry.descriptor.id, message.chat).enabled
    )
      return { status: 'ignored' }
    const resolver = this.resolver
    if (!resolver) throw new Error('IM 身份服务未就绪')
    const id = hash([
      connectionKey(entry.descriptor),
      message.chat.type,
      message.chat.id,
      message.id,
    ])
    return this.exclusive(`inbox:${id}`, async () => {
      this.assertEntry(entry)
      if (await this.db().selectFrom('inbox').select('id').where('id', '=', id).executeTakeFirst())
        return { status: 'duplicate' }
      const input: IdentityInput = { connection: structuredClone(entry.snapshot), message }
      const identity = await resolver.resolve(input)
      this.assertEntry(entry)
      if (this.resolver !== resolver) throw new Error('IM 身份服务已卸载')
      if (!(await resolver.validate(identity, input))) return { status: 'ignored' }
      await this.exclusive(`route:${identity.workspaceId}`, async () => {
        const route = await this.db()
          .selectFrom('route')
          .selectAll()
          .where('workspace_id', '=', identity.workspaceId)
          .executeTakeFirst()
        const values = {
          workspace_id: identity.workspaceId,
          connection_key: connectionKey(entry.descriptor),
          chat_type: message.chat.type,
          chat_id: message.chat.id,
        }
        if (!route) await this.db().insertInto('route').values(values).execute()
        else if (
          route.connection_key !== values.connection_key ||
          route.chat_type !== values.chat_type ||
          route.chat_id !== values.chat_id
        )
          throw new Error('IM 空间路由冲突')
      })
      const request = Object.freeze({})
      this.requests.set(request, { entry, identity, input, resolver })
      if (!(await this.authenticate(request))) return { status: 'ignored' }
      await this.db()
        .insertInto('inbox')
        .values({ id, status: 'processing', created_at: Date.now() })
        .execute()
      await this.rememberMessage(identity.workspaceId, message.id)
      const context: MessageContext = Object.freeze({
        ...identity,
        connection: input.connection,
        message,
        policy: this.getChatPolicy(entry.descriptor.id, message.chat),
        signal: entry.controller.signal,
        request,
        reply: async (
          segments: readonly MessageSegment[],
          options?: { idempotencyKey?: string },
        ) => {
          if (!(await this.authenticate(request))) throw new Error('IM 身份或空间已不可用')
          return this.send(
            {
              connectionId: entry.descriptor.id,
              workspaceId: identity.workspaceId,
              chat: message.chat,
            },
            segments,
            options,
          )
        },
      })
      const stages = { command: 0, message: 1, ai: 2 }
      try {
        for (const handler of [...this.handlers.values()].sort(
          (a, b) => stages[a.stage] - stages[b.stage],
        )) {
          if (this.handlers.get(handler.id) !== handler) continue
          if (!(await this.authenticate(request))) break
          const policy = this.getChatPolicy(entry.descriptor.id, message.chat)
          if (handler.stage === 'ai' && policy.ai !== true) continue
          const work = this.handlerWork.get(handler)
          if (!work || work.controller.signal.aborted) continue
          const invocation = Promise.resolve().then(() =>
            handler.handle(
              Object.freeze({
                ...context,
                policy,
                signal: AbortSignal.any([context.signal, work.controller.signal]),
              }),
            ),
          )
          work.pending.add(invocation)
          let result
          try {
            result = await invocation
          } finally {
            work.pending.delete(invocation)
          }
          if (result === 'consumed' || result === 'rejected') break
        }
        await this.db()
          .updateTable('inbox')
          .set({ status: 'processed' })
          .where('id', '=', id)
          .execute()
        return { status: 'processed' }
      } catch (error) {
        if (!entry.controller.signal.aborted)
          await this.db()
            .updateTable('inbox')
            .set({ status: 'failed' })
            .where('id', '=', id)
            .execute()
        throw error
      }
    })
  }
  async send(
    target: ScopedTarget,
    segments: readonly MessageSegment[],
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<{ messageId?: string }> {
    const entry = this.entry(target.connectionId)
    const route = await this.db()
      .selectFrom('route')
      .selectAll()
      .where('workspace_id', '=', target.workspaceId)
      .executeTakeFirst()
    if (
      !route ||
      route.connection_key !== connectionKey(entry.descriptor) ||
      route.chat_type !== target.chat.type ||
      route.chat_id !== target.chat.id
    )
      throw new Error('IM 发送目标不属于当前空间')
    if (!this.getChatPolicy(target.connectionId, target.chat).enabled)
      throw new Error('IM 聊天已禁用')
    for (const segment of segments) {
      if (segment.type !== 'reply') continue
      const reference = await this.db()
        .selectFrom('message_reference')
        .select('id')
        .where('id', '=', hash([target.workspaceId, segment.messageId]))
        .executeTakeFirst()
      if (!reference) throw new ImError(403, 'foreign_message', '引用消息不属于当前空间')
    }
    const deliver = async () => {
      this.assertEntry(entry)
      if (!this.getChatPolicy(target.connectionId, target.chat).enabled)
        throw new Error('IM 聊天已禁用')
      const operation = entry.descriptor.send(target.chat, segments, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([entry.controller.signal, options.signal])
          : entry.controller.signal,
      })
      entry.pending.add(operation)
      let result: { messageId?: string }
      try {
        result = await operation
      } finally {
        entry.pending.delete(operation)
      }
      if (result.messageId) await this.rememberMessage(target.workspaceId, result.messageId)
      return result
    }
    if (!options.idempotencyKey) return deliver()
    const id = hash([target.workspaceId, options.idempotencyKey])
    return this.exclusive(`outbox:${id}`, async () => {
      const prior = await this.db()
        .selectFrom('outbox')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (prior?.status === 'sent') return JSON.parse(prior.result) as { messageId?: string }
      if (prior) throw new ImError(409, 'delivery_unknown', 'IM 消息发送结果未知，禁止自动重复发送')
      await this.db().insertInto('outbox').values({ id, status: 'sending', result: '{}' }).execute()
      let result: { messageId?: string }
      try {
        result = await deliver()
      } catch {
        throw new ImError(409, 'delivery_unknown', 'IM 消息发送结果未知，禁止自动重复发送')
      }
      await this.db()
        .updateTable('outbox')
        .set({ status: 'sent', result: JSON.stringify(result) })
        .where('id', '=', id)
        .execute()
      return result
    })
  }
  private async rememberMessage(workspaceId: string, messageId: string) {
    const id = hash([workspaceId, messageId])
    await this.exclusive(`reference:${id}`, async () => {
      if (
        await this.db()
          .selectFrom('message_reference')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst()
      )
        return
      await this.db()
        .insertInto('message_reference')
        .values({ id, workspace_id: workspaceId, message_id: messageId })
        .execute()
    })
  }
  async invoke(
    target: ScopedTarget,
    action: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const entry = this.entry(target.connectionId)
    const route = await this.db()
      .selectFrom('route')
      .selectAll()
      .where('workspace_id', '=', target.workspaceId)
      .executeTakeFirst()
    if (
      !route ||
      route.connection_key !== connectionKey(entry.descriptor) ||
      route.chat_type !== target.chat.type ||
      route.chat_id !== target.chat.id
    )
      throw new Error('IM 操作目标不属于当前空间')
    if (!this.getChatPolicy(target.connectionId, target.chat).enabled)
      throw new Error('IM 聊天已禁用')
    this.assertEntry(entry)
    if (!entry.descriptor.capabilities?.includes(action) || !entry.descriptor.invoke)
      throw new Error('IM 接入不支持该操作')
    return entry.descriptor.invoke(action, target.chat, parameters)
  }
}
export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  async apply(ctx: Context, config: Config = {}) {
    const policies = await ctx.database
      .scope<Tables>(ctx, pluginId)
      .selectFrom('policy')
      .selectAll()
      .execute()
    await ctx.plugin(ImService, { config, policies })
  },
})
