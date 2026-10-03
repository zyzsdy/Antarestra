import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import '@antarestra/plugin-server'
import type { ChatTarget, ConnectionPolicy } from '@antarestra/im'
import '@antarestra/im'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { encodeMessage, id, normalizeMessage, record } from './message.js'

export const name = 'im-onebot'
export const inject = ['server', 'im']

export interface Config {
  id: string
  selfId: string
  tokenEnv?: string
  token?: string
  path?: string
  label?: string
  rpcTimeoutMs?: number
  ignoredUserIds?: string[]
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

function matches(actual: string | undefined, expected: string) {
  const left = Buffer.from(actual ?? '')
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function apply(ctx: Context, input: Config) {
  const config = schemaConfig(new URL('../config.schema.json', import.meta.url), input) as Config
  const token = config.token ?? (config.tokenEnv ? process.env[config.tokenEnv] : undefined)
  if (!token) throw new Error('OneBot 访问令牌未设置')
  const server = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  const pending = new Map<
    string,
    {
      socket: WebSocket
      resolve(value: unknown): void
      reject(error: Error): void
      cleanup(): void
    }
  >()
  let current: WebSocket | undefined
  let active = true
  const sentIds = new Set<string>()
  const logger = ctx.logger(name)
  const failPending = (socket: WebSocket | undefined, reason: string) => {
    for (const [key, entry] of pending) {
      if (socket && entry.socket !== socket) continue
      pending.delete(key)
      entry.cleanup()
      entry.reject(new Error(reason))
    }
  }
  const rpc = (
    action: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const socket = current
    if (!active || !socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('OneBot 连接尚未就绪'))
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const echo = randomUUID()
      const finish = (error: Error) => {
        const entry = pending.get(echo)
        if (!entry) return
        pending.delete(echo)
        entry.cleanup()
        reject(error)
      }
      const abort = () => finish(new Error('OneBot 调用已取消，发送结果可能未知'))
      const timer = setTimeout(
        () => finish(new Error('OneBot 调用超时，发送结果可能未知')),
        config.rpcTimeoutMs ?? 15000,
      )
      timer.unref()
      pending.set(echo, {
        socket,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) finish(new Error('OneBot 请求发送失败'))
      })
    })
  }
  const handle = ctx.im.registerConnection(ctx, {
    id: config.id,
    platform: 'onebot11',
    accountId: config.selfId,
    ...(config.label ? { label: config.label } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    capabilities: ['text', 'mention', 'reply', 'image', 'member', 'group.ban', 'group.kick'],
    async send(target, segments, options) {
      if (!allowed(config.policy, target)) throw new Error('目标聊天未获准接入')
      const data = record(
        await rpc(
          target.type === 'group' ? 'send_group_msg' : 'send_private_msg',
          {
            [target.type === 'group' ? 'group_id' : 'user_id']: target.id,
            message: encodeMessage(segments),
          },
          options?.signal,
        ),
      )
      const messageId = id(data.message_id)
      if (messageId) {
        sentIds.add(messageId)
        if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value!)
      }
      return messageId ? { messageId } : {}
    },
    async getMember(target, userId) {
      if (!allowed(config.policy, target)) return { active: false }
      if (target.type === 'private') return { active: target.id === userId, role: 'member' }
      const member = record(
        await rpc('get_group_member_info', {
          group_id: target.id,
          user_id: userId,
          no_cache: true,
        }),
      )
      return {
        active: id(member.user_id) === userId,
        role: member.role === 'admin' || member.role === 'owner' ? member.role : 'member',
      }
    },
    async invoke(action, target, parameters) {
      if (!allowed(config.policy, target) || target.type !== 'group')
        throw new Error('目标群未获准接入')
      if (action !== 'group.ban' && action !== 'group.kick') throw new Error('不支持的平台操作')
      const userId = id(parameters.userId)
      if (!userId) throw new Error('必须指定群成员')
      if (action === 'group.ban') {
        const duration = parameters.duration
        if (
          typeof duration !== 'number' ||
          !Number.isInteger(duration) ||
          duration < 0 ||
          duration > 2592000
        )
          throw new Error('禁言时长必须为 0 至 2592000 秒的整数')
        return rpc('set_group_ban', { group_id: target.id, user_id: userId, duration })
      }
      return rpc('set_group_kick', {
        group_id: target.id,
        user_id: userId,
        reject_add_request: false,
      })
    },
  })
  ctx.effect(() => async () => {
    active = false
    current = undefined
    failPending(undefined, 'OneBot 插件已卸载')
    sentIds.clear()
    await new Promise<void>((resolve) => {
      for (const socket of server.clients) socket.terminate()
      server.close(() => resolve())
    })
  })
  ctx.server.upgrade(
    ctx,
    config.path ?? `/im/onebot/${encodeURIComponent(config.id)}`,
    (request, socket, head) => {
      if (
        !active ||
        !matches(request.headers.authorization, `Bearer ${token}`) ||
        request.headers['x-self-id'] !== config.selfId ||
        request.headers['x-client-role'] !== 'Universal'
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      server.handleUpgrade(request, socket, head, (client) => {
        const previous = current
        current = client
        if (previous) {
          failPending(previous, 'OneBot 连接已被重新建立，发送结果可能未知')
          previous.terminate()
        }
        handle.setStatus('online')
        client.on('error', () => client.terminate())
        client.on('close', () => {
          failPending(client, 'OneBot 连接已断开，发送结果可能未知')
          if (active && current === client) {
            current = undefined
            handle.setStatus('offline')
          }
        })
        client.on('message', (raw) => {
          if (!active || current !== client) return
          let event: Record<string, unknown>
          try {
            event = record(JSON.parse(raw.toString()))
          } catch {
            return
          }
          const echo = typeof event.echo === 'string' ? event.echo : undefined
          if (echo) {
            const entry = pending.get(echo)
            if (!entry || entry.socket !== client) return
            pending.delete(echo)
            entry.cleanup()
            if (event.status === 'ok' && event.retcode === 0) entry.resolve(event.data)
            else entry.reject(new Error(`OneBot 操作失败（${String(event.retcode)}）`))
            return
          }
          const message = normalizeMessage(event, config.selfId)
          if (
            !message ||
            !allowed(config.policy, message.chat) ||
            config.ignoredUserIds?.includes(message.sender.id)
          )
            return
          message.replyToBot = message.segments.some(
            (segment) => segment.type === 'reply' && sentIds.has(segment.messageId),
          )
          void handle
            .receive(message)
            .catch(() => logger.warn('OneBot 消息处理失败，请检查 IM 运行状态'))
        })
      })
    },
  )
}
