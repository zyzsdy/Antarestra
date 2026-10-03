import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { Context, Service } from '@antarestra/plugin-sdk'
import type { ConnectionDescriptor, IncomingMessage } from '@antarestra/im'
import { normalizeMessage, encodeMessage } from '../../plugins/adapters/im-feishu/src/message.js'

const sdk = vi.hoisted(() => ({
  handler: undefined as ((event: unknown) => unknown) | undefined,
  ready: undefined as (() => void) | undefined,
  close: vi.fn(),
  request: vi.fn(),
  options: undefined as { httpInstance: { defaults: { signal: AbortSignal } } } | undefined,
}))
vi.mock('../../plugins/adapters/im-feishu/node_modules/@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 0 },
  AppType: { SelfBuild: 0 },
  Client: class {
    constructor(options: typeof sdk.options) {
      sdk.options = options
    }
    request = sdk.request
  },
  WSClient: class {
    constructor(options: { onReady: () => void }) {
      sdk.ready = options.onReady
    }
    start() {
      sdk.ready?.()
      return Promise.resolve()
    }
    close = sdk.close
  },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => unknown>) {
      sdk.handler = handlers['im.message.receive_v1']
      return this
    }
  },
}))
import * as Feishu from '../../plugins/adapters/im-feishu/src/index.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.clearAllMocks()
})

const account = { appId: 'cli_test', tenantId: 'tenant_test', botOpenId: 'ou_bot' }
const event = (changes: Record<string, unknown> = {}) => ({
  app_id: 'cli_test',
  tenant_key: 'tenant_test',
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' }, tenant_key: 'tenant_test' },
  message: {
    message_id: 'om_message',
    chat_id: 'oc_allowed',
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: '@_user_1 /ping' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '机器人' }],
  },
  ...changes,
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  let descriptor!: ConnectionDescriptor
  const received: IncomingMessage[] = []
  const statuses: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  class ImProbe extends Service {
    constructor(owner: Context) {
      super(owner, 'im')
    }
    registerConnection(_owner: Context, value: ConnectionDescriptor) {
      descriptor = value
      return {
        receive: async (message: IncomingMessage) => {
          received.push(message)
          await blocked
          return { status: 'processed' }
        },
        setStatus: (status: string) => statuses.push(status),
      }
    }
  }
  await ctx.plugin(ImProbe)
  const fiber = await ctx.plugin(Feishu, {
    id: 'feishu-test',
    ...account,
    appSecret: 'test-secret',
    policy: { group: { mode: 'whitelist', ids: ['oc_allowed'] } },
  })
  return { ctx, fiber, descriptor, received, statuses, release }
}

describe('飞书适配器（官方 SDK 边界模拟）', () => {
  it('使用消息资源鉴权接口下载媒体，并限制实际响应大小', async () => {
    const app = await setup()
    const message = normalizeMessage(event(), account)!
    sdk.request.mockResolvedValueOnce({
      data: Readable.from([Buffer.from('image')]),
      headers: { 'content-type': 'image/png' },
    })
    const result = await app.descriptor!.downloadMedia!(
      message,
      { type: 'image', url: 'feishu://image/img-key' },
      new AbortController().signal,
      20,
    )
    expect(Buffer.from(result.data).toString()).toBe('image')
    expect(sdk.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/im/v1/messages/om_message/resources/img-key',
        params: { type: 'image' },
        responseType: 'stream',
      }),
    )
    sdk.request.mockResolvedValueOnce({ data: Readable.from([Buffer.alloc(21)]), headers: {} })
    await expect(
      app.descriptor!.downloadMedia!(
        message,
        { type: 'file', url: 'feishu://file/file-key' },
        new AbortController().signal,
        20,
      ),
    ).rejects.toThrow('上限')
  })
  it('校验应用与租户，标记机器人并保留消息结构', () => {
    expect(normalizeMessage(event(), account)?.segments).toEqual([
      { type: 'mention', userId: 'ou_bot' },
      { type: 'text', text: ' /ping' },
    ])
    expect(normalizeMessage(event({ tenant_key: 'other' }), account)).toBeUndefined()
    expect(normalizeMessage(event({ app_id: 'other' }), account)).toBeUndefined()
    expect(
      normalizeMessage(
        event({ sender: { sender_type: 'app', sender_id: { open_id: 'ou_other' } } }),
        account,
      )?.sender.bot,
    ).toBe(true)
  })

  it('入口过滤白名单并及时确认事件，卸载关闭长连接和取消 HTTP', async () => {
    const app = await setup()
    expect(app.statuses).toContain('online')
    const source = event()
    expect(
      sdk.handler?.({ ...source, message: { ...source.message, chat_id: 'oc_other' } }),
    ).toBeUndefined()
    expect(app.received).toHaveLength(0)
    expect(sdk.handler?.(source)).toBeUndefined()
    expect(app.received).toHaveLength(1)
    // receive 仍未完成，但事件 handler 已返回确认。
    app.release()
    await app.fiber.dispose()
    expect(sdk.close).toHaveBeenCalledWith({ force: true })
    expect(sdk.options?.httpInstance.defaults.signal.aborted).toBe(true)
    sdk.handler?.(source)
    expect(app.received).toHaveLength(1)
  })

  it('使用原聊天发送、稳定幂等键、引用回复；出站同样受白名单限制', async () => {
    sdk.request.mockResolvedValue({ code: 0, data: { message_id: 'om_reply' } })
    const app = await setup()
    expect(
      await app.descriptor.send(
        { type: 'group', id: 'oc_allowed' },
        [{ type: 'text', text: '测试 < & >' }],
        { idempotencyKey: 'test-id' },
      ),
    ).toEqual({ messageId: 'om_reply' })
    expect(sdk.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/open-apis/im/v1/messages',
        params: { receive_id_type: 'chat_id' },
        data: expect.objectContaining({
          receive_id: 'oc_allowed',
          uuid: expect.stringMatching(/^[a-f0-9]{32}$/),
        }),
      }),
    )
    sdk.request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ message_id: 'om_source', chat_id: 'oc_allowed' }] },
    })
    await app.descriptor.send({ type: 'group', id: 'oc_allowed' }, [
      { type: 'reply', messageId: 'om_source' },
      { type: 'text', text: '回复' },
    ])
    expect(sdk.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: '/open-apis/im/v1/messages/om_source/reply' }),
    )
    await expect(
      app.descriptor.send({ type: 'private', id: 'oc_other' }, [{ type: 'text', text: '禁止' }]),
    ).rejects.toThrow('未获准')
    app.release()
  })

  it('平台媒体键可编码，外部 URL 与文本媒体混合明确拒绝', () => {
    expect(encodeMessage([{ type: 'image', url: 'feishu://image/img_key' }])).toEqual({
      msg_type: 'image',
      content: '{"image_key":"img_key"}',
    })
    expect(() => encodeMessage([{ type: 'image', url: 'https://example.test/image' }])).toThrow(
      '资源键',
    )
    expect(() =>
      encodeMessage([
        { type: 'text', text: '图' },
        { type: 'image', url: 'feishu://image/img_key' },
      ]),
    ).toThrow('单独发送')
  })

  it('拒绝跨聊天引用，避免 reply API 绕过白名单发送到原消息聊天', async () => {
    const app = await setup()
    sdk.request.mockResolvedValueOnce({
      code: 0,
      data: { items: [{ message_id: 'om_other', chat_id: 'oc_outside' }] },
    })
    await expect(
      app.descriptor.send({ type: 'group', id: 'oc_allowed' }, [
        { type: 'reply', messageId: 'om_other' },
        { type: 'text', text: '禁止外发' },
      ]),
    ).rejects.toThrow('不属于目标聊天')
    expect(sdk.request).toHaveBeenCalledTimes(1)
    expect(sdk.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }))
    app.release()
  })

  it('后台成员校验分页查询当前平台成员，拒绝退出成员、平台失败和未授权聊天', async () => {
    const app = await setup()
    sdk.request
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id: 'ou_other' }], has_more: true, page_token: 'next' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id: 'ou_user', tenant_key: 'tenant_test' }], has_more: false },
      })
    expect(
      await app.descriptor.getMember?.({ type: 'group', id: 'oc_allowed' }, 'ou_user'),
    ).toEqual({ active: true, role: 'member' })
    expect(sdk.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ page_token: 'next', member_id_type: 'open_id' }),
      }),
    )
    sdk.request.mockResolvedValueOnce({ code: 0, data: { items: [], has_more: false } })
    expect(
      await app.descriptor.getMember?.({ type: 'group', id: 'oc_allowed' }, 'ou_user'),
    ).toEqual({ active: false })
    sdk.request.mockRejectedValueOnce(new Error('模拟平台拒绝'))
    expect(
      await app.descriptor.getMember?.({ type: 'group', id: 'oc_allowed' }, 'ou_user'),
    ).toEqual({ active: false })
    const calls = sdk.request.mock.calls.length
    expect(
      await app.descriptor.getMember?.({ type: 'group', id: 'oc_outside' }, 'ou_user'),
    ).toEqual({ active: false })
    expect(sdk.request).toHaveBeenCalledTimes(calls)
    app.release()
  })
})
