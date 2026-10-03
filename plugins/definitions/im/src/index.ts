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
  ArchivedMessage,
  HistoryQuery,
  MediaArchive,
  MediaSegment,
} from './types.js'
export * from './types.js'
export { downloadHttpMedia } from './media.js'
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
function migrateSavedPolicy(value: string): ConnectionPolicy {
  const policy = JSON.parse(value)
  for (const chat of [
    policy.defaults,
    policy.group?.defaults,
    policy.private?.defaults,
    ...Object.values(policy.chats ?? {}),
  ]) {
    if (!chat || typeof chat !== 'object') continue
    const legacy = chat as Record<string, unknown>
    if (legacy.context && !legacy.userInputTemplate)
      legacy.userInputTemplate =
        legacy.context === 'recent' ? '{{history_message}}' : '{{last_message}}'
    if (typeof legacy.recentLimit === 'number' && legacy.historyLimit === undefined)
      legacy.historyLimit = Math.min(200, legacy.recentLimit + 1)
    delete legacy.context
    delete legacy.recentLimit
  }
  return validateConnectionPolicy(policy)
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
  private mediaArchive: MediaArchive | undefined
  private maintenance: Promise<void> | undefined
  private readonly abort = new AbortController()
  constructor(ctx: Context, options: ServiceOptions) {
    super(ctx, 'im')
    schemaConfig(new URL('../config.schema.json', import.meta.url), options.config)
    for (const row of options.policies) {
      this.saved.set(row.id, migrateSavedPolicy(row.value))
      this.revisions.set(row.id, row.revision)
    }
    const timer = setInterval(() => {
      if (!this.maintenance) {
        this.maintenance = this.maintainHistory()
          .catch(() => {
            if (!this.abort.signal.aborted) ctx.logger.warn('群消息媒体归档或清理暂不可用，将重试')
          })
          .finally(() => {
            this.maintenance = undefined
          })
      }
    }, 60_000)
    timer.unref()
    ctx.effect(() => async () => {
      clearInterval(timer)
      this.abort.abort()
      const pending = [...this.connections.values()].flatMap((entry) => [...entry.pending])
      for (const entry of this.connections.values()) entry.controller.abort()
      for (const entry of this.handlerWork.values()) entry.controller.abort()
      this.connections.clear()
      this.handlers.clear()
      this.resolver = undefined
      await Promise.allSettled([...pending, this.maintenance])
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
    if (!Number.isFinite(message.timestamp) || Math.abs(message.timestamp!) > 8640000000000000)
      message.timestamp = Date.now()
    if (
      !message.id ||
      !message.sender.id ||
      !message.chat.id ||
      !['private', 'group'].includes(message.chat.type)
    )
      throw new Error('IM 消息标识无效')
    if (!this.getChatPolicy(entry.descriptor.id, message.chat).enabled) return { status: 'ignored' }
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
      return this.exclusive(`dispatch:${identity.workspaceId}`, async () => {
        const request = Object.freeze({})
        this.requests.set(request, { entry, identity, input, resolver })
        if (!(await this.authenticate(request))) return { status: 'ignored' }
        for (const segment of message.segments) {
          if (segment.type !== 'reply') continue
          const original = await this.db()
            .selectFrom('history')
            .select('payload')
            .where('id', '=', hash([identity.workspaceId, segment.messageId]))
            .executeTakeFirst()
          if (
            original &&
            (JSON.parse(original.payload) as ArchivedMessage).message.sender.id ===
              entry.descriptor.accountId
          )
            message.replyToBot = true
        }
        const archived =
          message.chat.type === 'group'
            ? await this.archiveMessage(entry, identity.workspaceId, message)
            : undefined
        if (archived) await this.storeMedia(entry, archived)
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
          ...(archived ? { archived } : {}),
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
            if (
              message.passive ||
              message.sender.bot ||
              message.sender.id === entry.descriptor.accountId
            )
              break
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
      if (result.messageId && target.chat.type === 'group') {
        // 发送已成功，归档失败不能把平台投递变成未知并重复发送。
        try {
          const archived = await this.archiveMessage(entry, target.workspaceId, {
            id: result.messageId,
            chat: target.chat,
            sender: { id: entry.descriptor.accountId, bot: true },
            segments,
            timestamp: Date.now(),
          })
          await this.storeMedia(entry, archived)
        } catch {
          this.ctx.logger.warn('已发送群消息归档失败')
        }
      }
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
  registerMediaArchive(owner: Context, archive: MediaArchive) {
    if (this.mediaArchive) throw new Error('群消息媒体归档服务重复注册')
    const controller = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted()
      const task = Promise.resolve().then(operation)
      pending.add(task)
      void task.finally(() => pending.delete(task)).catch(() => {})
      return task
    }
    const registered: MediaArchive = {
      store: (message, media, download, signal) =>
        track(() =>
          archive.store(message, media, download, AbortSignal.any([signal, controller.signal])),
        ),
      retain: (workspaceId, policy) => track(() => archive.retain(workspaceId, policy)),
      available: (workspaceId, resourceId) =>
        track(() => archive.available(workspaceId, resourceId)),
    }
    return owner.effect(() => {
      this.mediaArchive = registered
      return async () => {
        if (this.mediaArchive === registered) this.mediaArchive = undefined
        controller.abort()
        await Promise.allSettled([...pending])
      }
    })
  }
  async preparePrivateMedia(context: MessageContext): Promise<MessageContext> {
    if (context.message.chat.type !== 'private' || !this.mediaArchive) return context
    const identity = await this.authenticate(context.request)
    if (!identity || identity.workspaceId !== context.workspaceId)
      throw new ImError(403, 'invalid_context', 'IM 空间授权无效')
    const entry = this.entry(context.connection.id)
    const message: ArchivedMessage = {
      id: hash([context.workspaceId, context.message.id]),
      workspaceId: context.workspaceId,
      connectionId: context.connection.id,
      platform: context.connection.platform,
      sequence: 0,
      receivedAt: Date.now(),
      message: context.message,
      media: [],
    }
    for (const [index, segment] of context.message.segments.entries()) {
      if (!('url' in segment)) continue
      const media: ArchivedMessage['media'][number] = {
        id: hash([message.id, index]),
        index,
        type: segment.type,
        status: 'pending',
      }
      message.media.push(media)
      try {
        if (!entry.descriptor.downloadMedia) throw new Error('接入不支持媒体下载')
        media.resource = await this.mediaArchive.store(
          message,
          media,
          (limit, signal) =>
            entry.descriptor.downloadMedia!(context.message, segment, signal, limit),
          context.signal,
        )
        media.status = 'stored'
      } catch {
        context.signal.throwIfAborted()
        media.status = 'failed'
      }
    }
    return { ...context, archived: message }
  }
  async mediaAvailable(workspaceId: string, resourceId: string) {
    return this.mediaArchive ? this.mediaArchive.available(workspaceId, resourceId) : false
  }
  private async archiveMessage(entry: Entry, workspaceId: string, message: IncomingMessage) {
    return this.exclusive(`history:${workspaceId}`, async () => {
      const id = hash([workspaceId, message.id])
      const prior = await this.db()
        .selectFrom('history')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (prior) return JSON.parse(prior.payload) as ArchivedMessage
      const last = await this.db()
        .selectFrom('history')
        .select('sequence')
        .where('workspace_id', '=', workspaceId)
        .orderBy('sequence', 'desc')
        .limit(1)
        .executeTakeFirst()
      const archived: ArchivedMessage = {
        id,
        workspaceId,
        connectionId: entry.snapshot.id,
        platform: entry.snapshot.platform,
        sequence: (last?.sequence ?? 0) + 1,
        receivedAt: Date.now(),
        message,
        media: message.segments.flatMap((segment, index) =>
          'url' in segment
            ? [{ id: hash([id, index]), index, type: segment.type, status: 'pending' as const }]
            : [],
        ),
      }
      await this.db()
        .insertInto('history')
        .values({
          id,
          workspace_id: workspaceId,
          connection_id: entry.snapshot.id,
          connection_key: connectionKey(entry.descriptor),
          sequence: archived.sequence,
          timestamp: Number.isFinite(message.timestamp) ? message.timestamp! : archived.receivedAt,
          sender_id: message.sender.id,
          text: message.segments
            .flatMap((segment) => (segment.type === 'text' ? [segment.text] : []))
            .join(''),
          payload: JSON.stringify(archived),
          media_pending: archived.media.length ? 1 : 0,
        })
        .execute()
      return archived
    })
  }
  private async storeMedia(entry: Entry, message: ArchivedMessage) {
    if (!message.media.length) return
    return this.exclusive(`media:${message.id}`, async () => {
      const stored = await this.db()
        .selectFrom('history')
        .select('payload')
        .where('id', '=', message.id)
        .executeTakeFirst()
      if (stored) message.media = (JSON.parse(stored.payload) as ArchivedMessage).media
      const archive = this.mediaArchive
      if (!archive) return
      const policy = this.getChatPolicy(entry.snapshot.id, message.message.chat)
      await archive.retain(message.workspaceId, policy)
      const signal = AbortSignal.any([entry.controller.signal, this.abort.signal])
      for (const media of message.media) {
        if (media.status === 'stored' || media.status === 'expired') continue
        const days = policy.mediaRetentionDays ?? 7
        if (
          days > 0 &&
          Date.now() - (message.message.timestamp ?? message.receivedAt) >= days * 86400000
        ) {
          media.status = 'expired'
          continue
        }
        try {
          if (!entry.descriptor.downloadMedia) throw new Error('接入不支持媒体下载')
          media.resource = await archive.store(
            message,
            media,
            (limit, downloadSignal) =>
              entry.descriptor.downloadMedia!(
                message.message,
                message.message.segments[media.index] as MediaSegment,
                downloadSignal,
                limit,
              ),
            signal,
          )
          media.status = 'stored'
        } catch {
          signal.throwIfAborted()
          media.status = 'failed'
          this.ctx.logger.warn('群消息媒体保存失败，保留消息与资源标识并等待重试')
        }
      }
      await this.db()
        .updateTable('history')
        .set({
          payload: JSON.stringify(message),
          media_pending: message.media.some(
            (media) => media.status === 'pending' || media.status === 'failed',
          )
            ? 1
            : 0,
        })
        .where('id', '=', message.id)
        .execute()
      await archive.retain(message.workspaceId, policy)
      for (const media of message.media)
        if (
          media.resource &&
          !(await archive.available(message.workspaceId, media.resource.resourceId))
        )
          media.status = 'expired'
    })
  }
  /** 服务端接口；AI 调用方必须从可信 RunContext 取得空间，不接受模型传入空间。 */
  async history(workspaceId: string, input: HistoryQuery = {}): Promise<ArchivedMessage[]> {
    let query = this.db().selectFrom('history').selectAll().where('workspace_id', '=', workspaceId)
    if (input.afterSequence !== undefined) query = query.where('sequence', '>', input.afterSequence)
    if (input.beforeSequence !== undefined)
      query = query.where('sequence', '<=', input.beforeSequence)
    if (input.startTime !== undefined) query = query.where('timestamp', '>=', input.startTime)
    if (input.endTime !== undefined) query = query.where('timestamp', '<=', input.endTime)
    if (input.senderId) query = query.where('sender_id', '=', input.senderId)
    // 关键词按原文子串匹配；数据库层不把 % 和 _ 当作用户通配符。
    const limit = Math.min(200, Math.max(0, input.limit ?? 50))
    if (!Number.isSafeInteger(limit)) throw new ImError(400, 'invalid_limit', '消息条数无效')
    if (!limit) return []
    const result: ArchivedMessage[] = []
    let before: number | undefined
    while (result.length < limit) {
      const rows = await (before === undefined ? query : query.where('sequence', '<', before))
        .orderBy('sequence', 'desc')
        .limit(200)
        .execute()
      for (const row of rows) {
        if (
          !input.keyword ||
          row.text.toLocaleLowerCase().includes(input.keyword.toLocaleLowerCase())
        )
          result.push(JSON.parse(row.payload) as ArchivedMessage)
        if (result.length === limit) break
      }
      if (rows.length < 200) break
      before = rows.at(-1)!.sequence
    }
    for (const message of result)
      for (const media of message.media) {
        if (
          media.resource &&
          this.mediaArchive &&
          !(await this.mediaArchive.available(workspaceId, media.resource.resourceId))
        )
          media.status = 'expired'
      }
    return result.reverse()
  }
  async maintainHistory() {
    if (!this.mediaArchive) return
    const routes = await this.db()
      .selectFrom('route')
      .selectAll()
      .where('chat_type', '=', 'group')
      .execute()
    for (const route of routes) {
      this.abort.signal.throwIfAborted()
      const entry = [...this.connections.values()].find(
        (entry) => connectionKey(entry.descriptor) === route.connection_key,
      )
      if (!entry) continue
      await this.mediaArchive.retain(
        route.workspace_id,
        this.getChatPolicy(entry.snapshot.id, { type: 'group', id: route.chat_id }),
      )
      let after = 0
      while (!this.abort.signal.aborted) {
        const rows = await this.db()
          .selectFrom('history')
          .selectAll()
          .where('workspace_id', '=', route.workspace_id)
          .where('media_pending', '=', 1)
          .where('sequence', '>', after)
          .orderBy('sequence')
          .limit(100)
          .execute()
        for (const row of rows)
          await this.storeMedia(entry, JSON.parse(row.payload) as ArchivedMessage)
        if (rows.length < 100) break
        after = rows.at(-1)!.sequence
      }
    }
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
