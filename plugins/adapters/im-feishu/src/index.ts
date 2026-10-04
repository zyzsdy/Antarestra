import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { ChatTarget, ConnectionPolicy } from '@antarestra/im'
import { downloadHttpMedia } from '@antarestra/im'
import * as lark from '@larksuiteoapi/node-sdk'
import axios from 'axios'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { encodeMessage, normalizeMessage } from './message.js'

export const name = 'im-feishu'
export const inject = ['im']
export interface Config {
  id: string
  appId: string
  appSecretEnv?: string
  appSecret?: string
  tenantId: string
  botOpenId: string
  label?: string
  policy?: ConnectionPolicy
}

function allowed(policy: ConnectionPolicy | undefined, target: ChatTarget) {
  const access = policy?.[target.type]
  return (
    policy?.enabled !== false &&
    !!access &&
    Array.isArray(access.ids) &&
    (access.mode === 'whitelist' || access.mode === 'blacklist') &&
    (access.mode === 'whitelist' ? access.ids.includes(target.id) : !access.ids.includes(target.id))
  )
}

interface SendResponse {
  code?: number
  data?: { message_id?: string }
}

interface MessageResponse {
  code?: number
  data?: { items?: { message_id?: string; chat_id?: string }[] }
}

interface MembersResponse {
  code?: number
  data?: {
    items?: { member_id?: string; tenant_key?: string }[]
    has_more?: boolean
    page_token?: string
  }
}

export function apply(ctx: Context, input: Config) {
  const config = schemaConfig(new URL('../config.schema.json', import.meta.url), input) as Config
  const appSecret =
    config.appSecret ?? (config.appSecretEnv ? process.env[config.appSecretEnv] : undefined)
  if (!appSecret) throw new Error('飞书应用密钥未设置')
  const stopped = new AbortController()
  // SDK HTTP 默认实例为全局对象；本插件独立创建实例并在卸载时取消在途请求。
  const http = axios.create({ timeout: 15000, signal: stopped.signal })
  http.interceptors.response.use((response) =>
    response.config.responseType === 'stream'
      ? { data: response.data, headers: response.headers }
      : response.data,
  )
  // Axios 类型不反映响应拦截器的拆包行为；此处限定为 SDK 的 HTTP 边界类型。
  type SdkHttp = NonNullable<ConstructorParameters<typeof lark.Client>[0]['httpInstance']>
  const httpInstance = http as unknown as SdkHttp
  const logger = ctx.logger(name)
  // SDK 的错误对象可能含有凭据和请求头，向日志只输出固定诊断。
  const sdkLogger = {
    error: (..._args: unknown[]) => logger.warn('飞书 SDK 请求或连接失败，请检查应用配置及网络'),
    warn: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
    trace: (..._args: unknown[]) => {},
  }
  const options = {
    appId: config.appId,
    appSecret,
    domain: lark.Domain.Feishu,
    httpInstance,
    logger: sdkLogger,
  }
  const client = new lark.Client({ ...options, appType: lark.AppType.SelfBuild })
  const sentIds = new Set<string>()
  const messageChats = new Map<string, string>()
  const rememberMessage = (messageId: string, chatId: string) => {
    messageChats.set(messageId, chatId)
    if (messageChats.size > 2000) messageChats.delete(messageChats.keys().next().value!)
  }
  const inFlight = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>) => {
    inFlight.add(promise)
    void promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    )
    return promise
  }
  const handle = ctx.im.registerConnection(ctx, {
    id: config.id,
    platform: 'feishu',
    accountId: config.botOpenId,
    tenantId: `${config.tenantId}:${config.appId}`,
    ...(config.label ? { label: config.label } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    capabilities: ['text', 'mention', 'reply', 'image.key', 'file.key', 'member'],
    validateMessage: (segments) => {
      encodeMessage(segments, true)
    },
    async prepareImage(image, signal) {
      const requestSignal = AbortSignal.any([signal, stopped.signal])
      return track(
        (async () => {
          try {
            const payload = await downloadHttpMedia(
              { type: 'image', url: image.url, name: image.filename },
              requestSignal,
              8 * 1024 ** 2,
            )
            requestSignal.throwIfAborted()
            const result = await client.request<{ code?: number; data?: { image_key?: string } }>({
              method: 'POST',
              url: '/open-apis/im/v1/images',
              headers: { 'Content-Type': 'multipart/form-data' },
              // SDK 会展开 data；必须传普通对象，由 Axios 按 multipart 编码 Buffer。
              data: { image_type: 'message', image: Buffer.from(payload.data) },
              timeout: 15000,
              signal: requestSignal,
            })
            requestSignal.throwIfAborted()
            if (result.code !== 0 || !result.data?.image_key) throw new Error('上传失败')
            return {
              type: 'image' as const,
              url: `feishu://image/${encodeURIComponent(result.data.image_key)}`,
            }
          } catch {
            // 原始异常可能包含签名链接、图片内容或平台凭据。
            throw new Error('飞书图片准备失败，请检查存储地址、图片格式和应用上传权限')
          }
        })(),
      )
    },
    async downloadMedia(message, segment, signal, maxBytes) {
      if (!allowed(config.policy, message.chat)) throw new Error('目标聊天未获准接入')
      const url = new URL(segment.url)
      if (url.protocol !== 'feishu:') throw new Error('飞书资源键无效')
      const fileKey = decodeURIComponent(url.pathname.slice(1))
      const requestSignal = AbortSignal.any([stopped.signal, signal, AbortSignal.timeout(60_000)])
      return track(
        (async () => {
          const result = await client.request<{ data: Readable; headers: Record<string, unknown> }>(
            {
              method: 'GET',
              url: `/open-apis/im/v1/messages/${encodeURIComponent(message.id)}/resources/${encodeURIComponent(fileKey)}`,
              params: { type: segment.type === 'image' ? 'image' : 'file' },
              responseType: 'stream',
              signal: requestSignal,
            },
          )
          const stream = result.data
          const abort = () => stream.destroy(new Error('媒体下载已取消'))
          requestSignal.addEventListener('abort', abort, { once: true })
          const chunks: Buffer[] = []
          let size = 0
          try {
            requestSignal.throwIfAborted()
            for await (const chunk of stream) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
              size += bytes.length
              if (size > maxBytes) throw new Error('媒体超过空间单文件上限')
              chunks.push(bytes)
            }
            const headers = result.headers as Record<string, unknown>
            const mimeType =
              typeof headers['content-type'] === 'string'
                ? headers['content-type'].split(';')[0]!
                : 'application/octet-stream'
            return { data: Buffer.concat(chunks), mimeType, filename: segment.name || segment.type }
          } finally {
            requestSignal.removeEventListener('abort', abort)
            stream.destroy()
          }
        })(),
      )
    },
    async getMember(target, userId, options) {
      stopped.signal.throwIfAborted()
      if (!allowed(config.policy, target) || !userId) return { active: false }
      const tokens = new Set<string>()
      let pageToken: string | undefined
      // 不缓存成员权限，后台恢复时重新查询。超出分页上限或平台拒绝时保持关闭。
      for (let page = 0; page < 100; page++) {
        let result: MembersResponse
        try {
          result = await track(
            client.request<MembersResponse>({
              method: 'GET',
              url: `/open-apis/im/v1/chats/${encodeURIComponent(target.id)}/members`,
              params: {
                member_id_type: 'open_id',
                page_size: 100,
                ...(pageToken ? { page_token: pageToken } : {}),
              },
              timeout: 15000,
              signal: stopped.signal,
            }),
          )
        } catch {
          return { active: false }
        }
        if (result.code !== 0 || !result.data || !Array.isArray(result.data.items))
          return { active: false }
        if (
          result.data.items.some(
            (member) =>
              member.member_id === userId &&
              (!member.tenant_key || member.tenant_key === config.tenantId),
          )
        ) {
          if (options?.includeRole && target.type === 'group') {
            try {
              const chat = await track(
                client.request<{
                  code?: number
                  data?: { owner_id?: string; owner_id_type?: string }
                }>({
                  method: 'GET',
                  url: `/open-apis/im/v1/chats/${encodeURIComponent(target.id)}`,
                  params: { user_id_type: 'open_id' },
                  timeout: 15000,
                  signal: stopped.signal,
                }),
              )
              if (
                chat.code === 0 &&
                chat.data?.owner_id_type === 'open_id' &&
                chat.data.owner_id === userId
              )
                return { active: true, role: 'owner' }
            } catch {
              /* 无法验证群主时不提升权限。 */
            }
          }
          return { active: true, role: 'member' }
        }
        if (!result.data.has_more) return { active: false }
        pageToken = result.data.page_token
        if (!pageToken || tokens.has(pageToken)) return { active: false }
        tokens.add(pageToken)
      }
      return { active: false }
    },
    async send(target, segments, sendOptions) {
      stopped.signal.throwIfAborted()
      if (!allowed(config.policy, target)) throw new Error('目标聊天未获准接入')
      const message = encodeMessage(segments)
      const signal = sendOptions?.signal
        ? AbortSignal.any([stopped.signal, sendOptions.signal])
        : stopped.signal
      const uuid = sendOptions?.idempotencyKey
        ? createHash('sha256').update(sendOptions.idempotencyKey).digest('hex').slice(0, 32)
        : undefined
      if (message.replyId) {
        let chatId = messageChats.get(message.replyId)
        if (!chatId) {
          let original: MessageResponse
          try {
            original = await track(
              client.request<MessageResponse>({
                method: 'GET',
                url: `/open-apis/im/v1/messages/${encodeURIComponent(message.replyId)}`,
                timeout: 15000,
                signal,
              }),
            )
          } catch {
            throw new Error('无法验证飞书引用消息所属聊天')
          }
          if (original.code === 0)
            chatId = original.data?.items?.find(
              (item) => item.message_id === message.replyId,
            )?.chat_id
        }
        if (chatId !== target.id) throw new Error('飞书引用消息不属于目标聊天或无法验证')
      }
      let result: SendResponse
      try {
        result = await track(
          client.request<SendResponse>({
            method: 'POST',
            url: message.replyId
              ? `/open-apis/im/v1/messages/${encodeURIComponent(message.replyId)}/reply`
              : '/open-apis/im/v1/messages',
            ...(!message.replyId ? { params: { receive_id_type: 'chat_id' } } : {}),
            data: {
              ...(!message.replyId ? { receive_id: target.id } : {}),
              msg_type: message.msg_type,
              content: message.content,
              ...(uuid ? { uuid } : {}),
            },
            timeout: 15000,
            signal,
          }),
        )
      } catch {
        throw new Error('飞书消息发送失败或结果未知，请检查连接状态')
      }
      if (result.code !== 0 || !result.data?.message_id)
        throw new Error(`飞书消息发送失败（${String(result.code)}）`)
      sentIds.add(result.data.message_id)
      rememberMessage(result.data.message_id, target.id)
      if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value!)
      return { messageId: result.data.message_id }
    },
  })
  const ws = new lark.WSClient({
    ...options,
    onReady: () => {
      if (!stopped.signal.aborted) handle.setStatus('online')
    },
    onReconnecting: () => {
      if (!stopped.signal.aborted) handle.setStatus('connecting')
    },
    onReconnected: () => {
      if (!stopped.signal.aborted) handle.setStatus('online')
    },
    onError: () => {
      if (!stopped.signal.aborted) handle.setStatus('error', '飞书长连接失败，请检查应用凭据及网络')
    },
  })
  ctx.effect(() => async () => {
    stopped.abort(new Error('飞书插件已卸载'))
    ws.close({ force: true })
    await Promise.allSettled([...inFlight])
    sentIds.clear()
    messageChats.clear()
  })
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (event) => {
      if (stopped.signal.aborted) return
      const message = normalizeMessage(event, config)
      if (!message || !allowed(config.policy, message.chat)) return
      rememberMessage(message.id, message.chat.id)
      message.replyToBot = message.segments.some(
        (segment) => segment.type === 'reply' && sentIds.has(segment.messageId),
      )
      // 尽快返回给 SDK 确认事件；AI 与命令通过 IM 核心异步运行。
      void handle.receive(message).catch(() => logger.warn('飞书消息处理失败，请检查 IM 运行状态'))
    },
  })
  // start 包含网络建连。卸载时先中止 HTTP 和关闭 WS，随后等待初始化退出。
  const starting = ws.start({ eventDispatcher: dispatcher })
  track(starting)
  void starting.catch(() => {
    if (!stopped.signal.aborted) handle.setStatus('error', '飞书长连接初始化失败')
  })
}
