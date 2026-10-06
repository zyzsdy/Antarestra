import { createHash } from 'node:crypto'
import { Service, type Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { migrations, pluginId, type Tables } from './schema.js'
import { describeArchiveError } from './diagnostics.js'
import { ImageResources, imageResourceId } from './resources.js'
import { messageSendDelay, waitForSend, type SendDelayConfig } from './send-delay.js'
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
  ArchivedMedia,
  HistoryQuery,
  MediaArchive,
  MediaSegment,
  AiHistoryReader,
  GroupSummary,
  ImageResource,
  ImageResourceResolver,
} from './types.js'
export * from './types.js'
export { imageResourceId } from './resources.js'
export { downloadHttpMedia } from './media.js'
export interface Config extends Partial<SendDelayConfig> {
  mediaMaxRetries?: number
}
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
  private readonly imageResources = new ImageResources()
  private aiHistoryReader: AiHistoryReader | undefined
  private maintenance: Promise<void> | undefined
  private readonly abort = new AbortController()
  private readonly mediaMaxRetries: number
  private readonly sendDelay: SendDelayConfig
  constructor(ctx: Context, options: ServiceOptions) {
    super(ctx, 'im')
    const config = schemaConfig<Required<Config>>(
      new URL('../config.schema.json', import.meta.url),
      options.config,
    )
    this.mediaMaxRetries = config.mediaMaxRetries
    this.sendDelay = config
    for (const row of options.policies) {
      this.saved.set(row.id, migrateSavedPolicy(row.value))
      this.revisions.set(row.id, row.revision)
    }
    const timer = setInterval(() => {
      if (!this.maintenance) {
        this.maintenance = this.maintainHistory()
          .catch((error: unknown) => {
            if (!this.abort.signal.aborted)
              ctx.logger.warn(
                '群消息媒体归档或清理暂不可用，下轮维护继续：%s',
                describeArchiveError(error),
              )
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
      policy: structuredClone(this.saved.get(connectionKey(descriptor)) ?? {}),
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
  registerAiHistory(owner: Context, reader: AiHistoryReader) {
    this.ctx.fiber.assertActive()
    if (this.aiHistoryReader) throw new Error('IM AI 历史读取器重复注册')
    return owner.effect(() => {
      this.aiHistoryReader = reader
      return () => {
        if (this.aiHistoryReader === reader) this.aiHistoryReader = undefined
      }
    })
  }
  get aiHistory() {
    this.ctx.fiber.assertActive()
    return this.aiHistoryReader
  }
  /** 仅供已授权的管理入口读取；群空间由持久化路由解析。 */
  async listGroups(offset = 0, limit = 20) {
    const query = this.db().selectFrom('route').where('chat_type', '=', 'group')
    const count = await query
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow()
    const routes = await query
      .selectAll()
      .orderBy('workspace_id')
      .offset(offset)
      .limit(limit)
      .execute()
    const groups: GroupSummary[] = await Promise.all(
      routes.map(async (route) => {
        const latest = await this.db()
          .selectFrom('history')
          .selectAll()
          .where('workspace_id', '=', route.workspace_id)
          .orderBy('sequence', 'desc')
          .limit(1)
          .executeTakeFirst()
        const archived = latest ? (JSON.parse(latest.payload) as ArchivedMessage) : undefined
        const entry = [...this.connections.values()].find(
          (item) => connectionKey(item.descriptor) === route.connection_key,
        )
        return {
          workspaceId: route.workspace_id,
          connectionId: entry?.snapshot.id ?? archived?.connectionId ?? '',
          platform: entry?.snapshot.platform ?? archived?.platform ?? '',
          chatId: route.chat_id,
          name: route.chat_name || archived?.message.chatName || route.chat_id,
          lastMessageAt: latest?.timestamp ?? null,
        }
      }),
    )
    return { groups, total: Number(count.total) }
  }
  async requireGroup(workspaceId: string) {
    const route = await this.db()
      .selectFrom('route')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('chat_type', '=', 'group')
      .executeTakeFirst()
    if (!route) throw new ImError(404, 'not_found', '群聊记录不存在')
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
    const allowed = admits(policy)
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
  /** 仅查询已鉴权入站消息发送者的当前平台身份，不能由命令参数指定群或发送者。 */
  async requestMember(request: object) {
    if (!(await this.authenticate(request))) return
    const trusted = this.requests.get(request)!
    const { entry, input } = trusted
    if (!entry.descriptor.getMember) return
    const work = entry.descriptor.getMember(input.message.chat, input.message.sender.id, {
      includeRole: true,
    })
    entry.pending.add(work)
    try {
      const member = await work
      if (!(await this.authenticate(request))) return
      return member
    } finally {
      entry.pending.delete(work)
    }
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
          chat_name: message.chatName || null,
        }
        if (!route) await this.db().insertInto('route').values(values).execute()
        else if (
          route.connection_key !== values.connection_key ||
          route.chat_type !== values.chat_type ||
          route.chat_id !== values.chat_id
        )
          throw new Error('IM 空间路由冲突')
        if (route && message.chatName && route.chat_name !== message.chatName)
          await this.db()
            .updateTable('route')
            .set({ chat_name: message.chatName })
            .where('workspace_id', '=', identity.workspaceId)
            .execute()
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
        let forwardedMessage = message
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
                  message: forwardedMessage,
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
            if (result && typeof result === 'object' && result.type === 'continue')
              forwardedMessage = { ...message, segments: [...result.segments] }
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
  async validateSend(target: ScopedTarget, segments: readonly MessageSegment[]): Promise<void> {
    await this.validateMessage(target, segments, true)
  }
  private async validateMessage(
    target: ScopedTarget,
    segments: readonly MessageSegment[],
    resources: boolean,
  ) {
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
      if (resources && segment.type === 'image') {
        const resourceId = imageResourceId(segment.url)
        if (resourceId !== undefined)
          await this.imageResources
            .get()
            .inspect(target.workspaceId, resourceId, entry.controller.signal)
      }
      if (segment.type !== 'reply') continue
      const reference = await this.db()
        .selectFrom('message_reference')
        .select('id')
        .where('id', '=', hash([target.workspaceId, segment.messageId]))
        .executeTakeFirst()
      if (!reference) throw new ImError(403, 'foreign_message', '引用消息不属于当前空间')
    }
    entry.descriptor.validateMessage?.(segments)
  }
  registerImageResources(owner: Context, resolver: ImageResourceResolver) {
    this.ctx.fiber.assertActive()
    return this.imageResources.register(owner, resolver)
  }
  private async prepareImages(
    entry: Entry,
    target: ScopedTarget,
    segments: readonly MessageSegment[],
    signal: AbortSignal,
  ) {
    const prepared = [...segments]
    const resources = new Map<number, ImageResource>()
    for (const [index, segment] of segments.entries()) {
      if (segment.type !== 'image') continue
      const id = imageResourceId(segment.url)
      if (id === undefined) continue
      const resolver = this.imageResources.get()
      const image = await resolver.inspect(target.workspaceId, id, signal)
      const link = await resolver.resolve(target.workspaceId, id, signal)
      const url = new URL(link.url)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !Number.isFinite(link.expiresAt) ||
        link.expiresAt <= Date.now()
      )
        throw new Error('图片临时地址无效或已过期')
      signal.throwIfAborted()
      prepared[index] = entry.descriptor.prepareImage
        ? await entry.descriptor.prepareImage({ ...image, url: link.url }, signal)
        : { ...segment, url: link.url }
      resources.set(index, image)
    }
    return { segments: prepared, resources }
  }
  async send(
    target: ScopedTarget,
    segments: readonly MessageSegment[],
    options: {
      idempotencyKey?: string
      signal?: AbortSignal
      /** 同一次回复的后续消息；首条或独立消息默认不按字数等待。 */
      continuation?: boolean
      /** 在排队及延迟完成后、调用平台前重新检查业务授权。 */
      beforeSend?: () => void | Promise<void>
    } = {},
  ): Promise<{ messageId?: string }> {
    const entry = this.entry(target.connectionId)
    let suppressed = false
    const transformText = entry.descriptor.transformText
    if (transformText) {
      let changed = false
      const transformed = segments.map((segment) => {
        if (segment.type !== 'text') return segment
        const text = transformText(segment.text)
        if (text !== segment.text) changed = true
        return { ...segment, text }
      })
      if (changed) {
        segments = transformed.filter((segment) => segment.type !== 'text' || segment.text.trim())
        suppressed = !segments.some((segment) => segment.type !== 'reply')
      }
    }
    const signal = options.signal
      ? AbortSignal.any([entry.controller.signal, options.signal])
      : entry.controller.signal
    const deliver = async (prepared: Awaited<ReturnType<ImService['prepareImages']>>) => {
      this.assertEntry(entry)
      signal.throwIfAborted()
      if (!this.getChatPolicy(target.connectionId, target.chat).enabled)
        throw new Error('IM 聊天已禁用')
      // 转换后只剩空白或引用时正常完成；幂等结果仍保存，但不发送或归档空消息。
      if (suppressed) return {}
      const result = await entry.descriptor.send(target.chat, prepared.segments, {
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        signal,
      })
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
          // 内部资源直接复用原文件；历史不保存签名 URL，也不下载并重复占用配额。
          for (const media of archived.media) {
            const resource = prepared.resources.get(media.index)
            if (!resource) continue
            media.resource = resource
            media.status = 'stored'
          }
          if (prepared.resources.size) await this.saveMediaState(archived)
          await this.storeMedia(entry, archived)
        } catch (error) {
          this.ctx.logger.warn('已发送群消息归档失败：%o', {
            connectionId: target.connectionId,
            workspaceId: target.workspaceId,
            chatId: target.chat.id,
            messageId: result.messageId,
            reason: describeArchiveError(error),
          })
        }
      }
      return result
    }
    const dispatch = async (id?: string) => {
      this.assertEntry(entry)
      signal.throwIfAborted()
      // 已发送的幂等记录不依赖资源仍存在，避免恢复时卡在已删除的旧图片。
      await this.validateMessage(target, segments, false)
      if (id) {
        const prior = await this.db()
          .selectFrom('outbox')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst()
        if (prior?.status === 'sent') return JSON.parse(prior.result) as { messageId?: string }
        if (prior)
          throw new ImError(409, 'delivery_unknown', 'IM 消息发送结果未知，禁止自动重复发送')
      }
      await this.validateSend(target, segments)
      if (target.chat.type === 'group' && options.continuation)
        await waitForSend(messageSendDelay(segments, this.sendDelay), signal)
      // 等待期间可能撤销聊天或业务权限，必须在真正发送前重新校验。
      await this.validateSend(target, segments)
      // 签名和平台上传在认领投递前完成；准备失败不应成为投递结果未知。
      const prepared = await this.prepareImages(entry, target, segments, signal)
      await this.validateSend(target, segments)
      await options.beforeSend?.()
      this.assertEntry(entry)
      signal.throwIfAborted()
      if (!id) return deliver(prepared)
      // 仅在等待完成后认领投递；未调用平台的取消仍可以安全重试。
      await this.db().insertInto('outbox').values({ id, status: 'sending', result: '{}' }).execute()
      let result: { messageId?: string }
      try {
        result = await deliver(prepared)
      } catch {
        throw new ImError(409, 'delivery_unknown', 'IM 消息发送结果未知，禁止自动重复发送')
      }
      await this.db()
        .updateTable('outbox')
        .set({ status: 'sent', result: JSON.stringify(result) })
        .where('id', '=', id)
        .execute()
      return result
    }
    const send = () => {
      if (!options.idempotencyKey) return dispatch()
      const id = hash([target.workspaceId, options.idempotencyKey])
      return this.exclusive(`outbox:${id}`, () => dispatch(id))
    }
    // 同一接入的同一群逐条等待并发送，不同群和接入互不阻塞。
    const work =
      target.chat.type === 'group'
        ? this.exclusive(`send:${hash([connectionKey(entry.descriptor), target.chat.id])}`, send)
        : send()
    entry.pending.add(work)
    try {
      return await work
    } finally {
      entry.pending.delete(work)
    }
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
            this.downloadMedia(
              {
                connectionId: entry.descriptor.id,
                workspaceId: context.workspaceId,
                chat: context.message.chat,
              },
              context.message,
              segment,
              signal,
              limit,
            ),
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
        if (!this.canStoreMedia(media)) continue
        const days = policy.mediaRetentionDays ?? 7
        if (
          days > 0 &&
          Date.now() - (message.message.timestamp ?? message.receivedAt) >= days * 86400000
        ) {
          media.status = 'expired'
          await this.saveMediaState(message)
          continue
        }
        const attempts = media.attempts ?? (media.status === 'failed' ? 1 : 0)
        try {
          signal.throwIfAborted()
          if (!entry.descriptor.downloadMedia) throw new Error('接入不支持媒体下载')
          media.resource = await archive.store(
            message,
            media,
            (limit, downloadSignal) =>
              this.downloadMedia(
                {
                  connectionId: entry.descriptor.id,
                  workspaceId: message.workspaceId,
                  chat: message.message.chat,
                },
                message.message,
                message.message.segments[media.index] as MediaSegment,
                downloadSignal,
                limit,
              ),
            signal,
          )
          media.status = 'stored'
          delete media.lastError
        } catch (error) {
          signal.throwIfAborted()
          media.status = 'failed'
          media.lastError = describeArchiveError(error)
        }
        media.attempts = attempts + 1
        // 每个资源完成后立即持久化，后续资源被取消或插件重载不会重置已发生的失败。
        await this.saveMediaState(message)
        if (media.status === 'failed') {
          const details = {
            connectionId: entry.snapshot.id,
            platform: message.platform,
            workspaceId: message.workspaceId,
            chatId: message.message.chat.id,
            messageId: message.message.id,
            mediaId: media.id,
            mediaIndex: media.index,
            mediaType: media.type,
            attempts: media.attempts,
            retries: Math.max(0, media.attempts - 1),
            maxRetries: this.mediaMaxRetries,
            reason: media.lastError,
          }
          if (this.canStoreMedia(media))
            this.ctx.logger.warn('群消息媒体保存失败，保留消息与资源标识并等待重试：%o', details)
          else
            this.ctx.logger.error(
              '群消息媒体保存失败，已达重试上限，停止自动重试并保留记录：%o',
              details,
            )
        }
      }
      // 兼容已经耗尽次数、或因配置下调而不再符合重试条件的记录。
      await this.saveMediaState(message)
      await archive.retain(message.workspaceId, policy)
      for (const media of message.media)
        if (
          media.resource &&
          !(await archive.available(message.workspaceId, media.resource.resourceId))
        )
          media.status = 'expired'
    })
  }
  private canStoreMedia(media: ArchivedMedia) {
    return (
      media.status === 'pending' ||
      (media.status === 'failed' && (media.attempts ?? 1) <= this.mediaMaxRetries)
    )
  }
  private async saveMediaState(message: ArchivedMessage) {
    await this.db()
      .updateTable('history')
      .set({
        payload: JSON.stringify(message),
        media_pending: message.media.some((media) => this.canStoreMedia(media)) ? 1 : 0,
      })
      .where('id', '=', message.id)
      .execute()
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
  /** 从持久化空间路由解析目标，不接受模型指定连接或聊天。 */
  async resolveTarget(workspaceId: string): Promise<ScopedTarget> {
    const route = await this.db()
      .selectFrom('route')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst()
    const entry =
      route &&
      [...this.connections.values()].find(
        (entry) => connectionKey(entry.descriptor) === route.connection_key,
      )
    if (!route || !entry) throw new ImError(404, 'not_found', '当前空间没有可用的 IM 接入')
    this.assertEntry(entry)
    if (route.chat_type !== 'group' && route.chat_type !== 'private')
      throw new ImError(400, 'invalid_route', 'IM 聊天类型无效')
    const chat: ChatTarget = { type: route.chat_type, id: route.chat_id }
    if (!this.getChatPolicy(entry.descriptor.id, chat).enabled)
      throw new ImError(403, 'forbidden', 'IM 聊天已禁用')
    return { workspaceId, connectionId: entry.descriptor.id, chat }
  }
  /** 可信服务端消费方下载当前空间中的媒体，沿用接入的下载与卸载生命周期。 */
  async downloadMedia(
    target: ScopedTarget,
    message: IncomingMessage,
    segment: MediaSegment,
    signal: AbortSignal,
    maxBytes: number,
  ) {
    const resolved = await this.resolveTarget(target.workspaceId)
    if (
      resolved.connectionId !== target.connectionId ||
      resolved.chat.type !== target.chat.type ||
      resolved.chat.id !== target.chat.id ||
      message.chat.type !== target.chat.type ||
      message.chat.id !== target.chat.id
    )
      throw new ImError(403, 'forbidden', '媒体下载目标不属于当前空间')
    const entry = this.entry(target.connectionId)
    if (!entry.descriptor.downloadMedia) throw new ImError(400, 'unsupported', '接入不支持媒体下载')
    const combined = AbortSignal.any([signal, entry.controller.signal])
    combined.throwIfAborted()
    const work = entry.descriptor.downloadMedia(message, segment, combined, maxBytes)
    entry.pending.add(work)
    try {
      const result = await work
      combined.throwIfAborted()
      return result
    } finally {
      entry.pending.delete(work)
    }
  }
  async invoke(
    target: ScopedTarget,
    action: string,
    parameters: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
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
    if (action === 'message.recall') {
      const messageId = parameters.message_id
      if (typeof messageId !== 'string' || !messageId.trim())
        throw new ImError(400, 'invalid_message', '必须指定要撤回的原始消息 ID')
      const reference = await this.db()
        .selectFrom('message_reference')
        .select('id')
        .where('id', '=', hash([target.workspaceId, messageId]))
        .executeTakeFirst()
      if (!reference) throw new ImError(403, 'foreign_message', '撤回消息不属于当前空间')
    }
    this.assertEntry(entry)
    if (!entry.descriptor.capabilities?.includes(action) || !entry.descriptor.invoke)
      throw new ImError(400, 'unsupported', 'IM 接入不支持该操作')
    const combined = signal
      ? AbortSignal.any([signal, entry.controller.signal])
      : entry.controller.signal
    combined.throwIfAborted()
    const work = entry.descriptor.invoke(action, target.chat, parameters, combined)
    entry.pending.add(work)
    try {
      return await work
    } finally {
      entry.pending.delete(work)
    }
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
