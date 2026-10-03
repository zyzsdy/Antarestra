import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@antarestra/plugin-sdk'
import type { ConnectionDescriptor, IncomingMessage } from '@antarestra/im'
import Server from '@antarestra/plugin-server'
import { WebSocket } from 'ws'
import * as OneBot from '../../plugins/adapters/im-onebot/src/index.js'
import { normalizeMessage } from '../../plugins/adapters/im-onebot/src/message.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  let descriptor!: ConnectionDescriptor
  const received: IncomingMessage[] = []
  const statuses: string[] = []
  class ImProbe extends Service {
    constructor(owner: Context) {
      super(owner, 'im')
    }
    registerConnection(_owner: Context, value: ConnectionDescriptor) {
      descriptor = value
      return {
        receive: async (message: IncomingMessage) => {
          received.push(message)
          return { status: 'processed' }
        },
        setStatus: (status: string) => statuses.push(status),
      }
    }
  }
  await ctx.plugin(ImProbe)
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  const adapter = await ctx.plugin(OneBot, {
    id: 'test',
    selfId: '152408856',
    token: 'test-secret',
    rpcTimeoutMs: 100,
    policy: {
      private: { mode: 'whitelist', ids: [] },
      group: { mode: 'whitelist', ids: ['40894918'] },
    },
  })
  const url = `ws://127.0.0.1:${ctx.server.address!.port}/im/onebot/test`
  const connect = async (headers: Record<string, string> = {}) => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: 'Bearer test-secret',
        'X-Self-ID': '152408856',
        'X-Client-Role': 'Universal',
        ...headers,
      },
    })
    cleanups.push(async () => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return socket
  }
  return { ctx, adapter, connect, descriptor, received, statuses }
}

const event = (changes: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 152408856,
  user_id: 79338528,
  group_id: 40894918,
  message_id: 1,
  sender: { nickname: '测试成员', role: 'member' },
  message: [{ type: 'text', data: { text: '/ping' } }],
  ...changes,
})

describe('OneBot 11 反向 WebSocket', () => {
  it('校验令牌、账号、角色，在入口排除未准入聊天与错误账号，自身消息交给核心归档', async () => {
    const app = await setup()
    await expect(app.connect({ Authorization: 'Bearer wrong' })).rejects.toThrow('401')
    await expect(app.connect({ 'X-Self-ID': '123' })).rejects.toThrow('401')
    await expect(app.connect({ 'X-Client-Role': 'Event' })).rejects.toThrow('401')
    const socket = await app.connect()
    for (const message of [
      event({ group_id: 123 }),
      event({ message_type: 'private' }),
      event({ user_id: 152408856 }),
      event({ self_id: 999 }),
      event(),
    ])
      socket.send(JSON.stringify(message))
    await expect.poll(() => app.received.length).toBe(2)
    expect(app.received[0]?.chat).toEqual({ type: 'group', id: '40894918' })
    expect(app.statuses.at(-1)).toBe('online')
  })

  it('RPC echo 关联回复、验证引用，拒绝越界发送，超时和卸载取消待处理调用', async () => {
    const app = await setup()
    const socket = await app.connect()
    socket.once('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        echo: string
        action: string
        params: Record<string, unknown>
      }
      expect(request.action).toBe('send_group_msg')
      expect(request.params.group_id).toBe('40894918')
      socket.send(
        JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { message_id: 42 } }),
      )
    })
    expect(
      await app.descriptor.send({ type: 'group', id: '40894918' }, [
        { type: 'text', text: '测试回复' },
      ]),
    ).toEqual({ messageId: '42' })
    socket.send(
      JSON.stringify(
        event({
          message: [
            { type: 'reply', data: { id: 42 } },
            { type: 'text', data: { text: '继续' } },
          ],
        }),
      ),
    )
    await expect.poll(() => app.received.length).toBe(1)
    expect(app.received[0]?.replyToBot).toBe(true)
    await expect(
      app.descriptor.send({ type: 'group', id: '123' }, [{ type: 'text', text: '禁止' }]),
    ).rejects.toThrow('未获准')
    await expect(
      app.descriptor.send({ type: 'group', id: '40894918' }, [{ type: 'text', text: '超时' }]),
    ).rejects.toThrow('超时')
    const pending = app.descriptor.send({ type: 'group', id: '40894918' }, [
      { type: 'text', text: '卸载' },
    ])
    const rejected = expect(pending).rejects.toThrow('卸载')
    await app.adapter.dispose()
    await rejected
    await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED)
  })

  it('重连替换旧连接，旧连接未完成的请求不会由新连接回应完成', async () => {
    const app = await setup()
    const first = await app.connect()
    const pending = app.descriptor.send({ type: 'group', id: '40894918' }, [
      { type: 'text', text: '旧连接' },
    ])
    const rejected = expect(pending).rejects.toThrow('重新建立')
    await app.connect()
    await rejected
    await expect.poll(() => first.readyState).toBe(WebSocket.CLOSED)
    expect(app.statuses.at(-1)).toBe('online')
  })

  it('保留 @、引用和媒体结构，标记机器人发言并忽略字符串 CQ 消息', () => {
    const message = normalizeMessage(
      event({
        message: [
          { type: 'at', data: { qq: '152408856' } },
          { type: 'image', data: { url: 'https://example.test/image.png' } },
          { type: 'file', data: { url: 'https://example.test/file.txt', name: '文件.txt' } },
        ],
      }),
      '152408856',
    )
    expect(message?.segments).toEqual([
      { type: 'mention', userId: '152408856' },
      { type: 'image', url: 'https://example.test/image.png' },
      { type: 'file', url: 'https://example.test/file.txt', name: '文件.txt' },
    ])
    expect(normalizeMessage(event({ sender: { is_bot: true } }), '152408856')?.sender.bot).toBe(
      true,
    )
    expect(
      normalizeMessage(event({ message: '[CQ:at,qq=152408856]' }), '152408856')?.segments,
    ).toEqual([{ type: 'mention', userId: '152408856' }])
  })
})
