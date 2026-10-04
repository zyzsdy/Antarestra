import { setTimeout as realDelay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { Config, MessageSegment } from '@antarestra/im'
import imAi from '@antarestra/plugin-im-ai'
import { messageSendDelay, waitForSend } from '../../plugins/definitions/im/src/send-delay.js'
import { parseReply } from '../../plugins/features/im-ai/src/reply.js'
import { filterCitationLinks } from '../../plugins/adapters/im-onebot/src/citation-links.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const schema = new URL('../../plugins/definitions/im/config.schema.json', import.meta.url)
const defaults = schemaConfig<Required<Config>>(schema, {})
const text = (value: string): MessageSegment[] => [{ type: 'text', text: value }]
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 10 })

async function prepare(config: Config = {}) {
  const app = await setup({ imConfig: config })
  await app.connection.receive('建立空间')
  const target = await app.ctx.im.resolveTarget(app.messages[0]!.workspaceId)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  return { ...app, target }
}

it('默认值为 100、100、20，按整条消息严格切换阈值，0 关闭延迟', () => {
  expect(defaults).toMatchObject({
    sendDelayPerCharMs: 100,
    longMessageThreshold: 100,
    longMessageDelayPerCharMs: 20,
  })
  expect(messageSendDelay(text('字'.repeat(10)), defaults)).toBe(1000)
  expect(messageSendDelay(text('字'.repeat(100)), defaults)).toBe(10000)
  expect(messageSendDelay(text('字'.repeat(101)), defaults)).toBe(2020)
  expect(messageSendDelay(text('字'.repeat(101)), { ...defaults, sendDelayPerCharMs: 0 })).toBe(0)
  expect(
    messageSendDelay(text('字'.repeat(101)), { ...defaults, longMessageDelayPerCharMs: 0 }),
  ).toBe(0)
  expect(
    messageSendDelay(text('四个文字'), {
      sendDelayPerCharMs: 150,
      longMessageThreshold: 3,
      longMessageDelayPerCharMs: 30,
    }),
  ).toBe(120)
})

it('仅统计解码后的文本码点，合并文本片段，不计算标签或媒体地址', () => {
  const [segments] = parseReply(
    '<im_reply><message quote="123">你😀&amp;<at id="456"></at> 好</message></im_reply>',
  )
  expect(messageSendDelay(segments!, defaults)).toBe(500)
  expect(messageSendDelay([...text('字'.repeat(60)), ...text('字'.repeat(41))], defaults)).toBe(
    2020,
  )
  expect(
    messageSendDelay([{ type: 'image', url: 'https://example.com/image.png' }], defaults),
  ).toBe(0)
})

it.each(['sendDelayPerCharMs', 'longMessageThreshold', 'longMessageDelayPerCharMs'])(
  '参数 %s 拒绝负数、小数、非数字和超界值',
  (key) => {
    for (const value of [-1, 1.5, '100', 2 ** 31])
      expect(() => schemaConfig(schema, { [key]: value })).toThrow('配置校验失败')
  },
)

it('两条七字消息分别等待 700 毫秒，同群并发发送不会同时计时', async () => {
  const app = await prepare()
  const first = app.ctx.im.send(app.target, text('这是第一条消息'))
  const second = app.ctx.im.send(app.target, text('这是第二条消息'))
  await vi.advanceTimersByTimeAsync(699)
  expect(app.sent).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  await first
  expect(app.sent.map((entry) => entry.segments)).toEqual([text('这是第一条消息')])
  await vi.advanceTimersByTimeAsync(699)
  expect(app.sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  await second
  expect(app.sent.map((entry) => entry.segments)).toEqual([
    text('这是第一条消息'),
    text('这是第二条消息'),
  ])
  expect(vi.getTimerCount()).toBe(0)
})

it('出站文本转换后的字数决定延迟，不计入被移除的引用链接', async () => {
  const app = await setup({ imConfig: { sendDelayPerCharMs: 100 } })
  const send = vi.fn(async () => ({ messageId: 'filtered' }))
  const connection = app.ctx.im.registerConnection(app.ctx, {
    id: 'filtered',
    platform: 'onebot11',
    accountId: '06',
    policy: app.defaultPolicy,
    transformText: filterCitationLinks,
    send,
  })
  await connection.receive({
    id: 'incoming',
    chat: { type: 'group', id: '40894918' },
    sender: { id: '79338528' },
    segments: text('建立空间'),
  })
  const target = await app.ctx.im.resolveTarget(app.messages[0]!.workspaceId)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const work = app.ctx.im.send(target, text('你好 ([来源](https://example.com/a?x=1&y=2))'))
  await vi.advanceTimersByTimeAsync(199)
  expect(send).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await work
  expect(send).toHaveBeenCalledExactlyOnceWith(target.chat, text('你好'), expect.any(Object))
})

it.each([
  [{}, 100, 10000],
  [{}, 101, 2020],
  [{ sendDelayPerCharMs: 0 }, 101, 0],
  [{ longMessageDelayPerCharMs: 0 }, 101, 0],
  [{ sendDelayPerCharMs: 30, longMessageThreshold: 5, longMessageDelayPerCharMs: 10 }, 6, 60],
])('真实发送入口应用配置 %j：%i 个字等待 %i 毫秒', async (config, length, milliseconds) => {
  const app = await prepare(config)
  const work = app.ctx.im.send(app.target, text('字'.repeat(length)))
  if (milliseconds) {
    await vi.advanceTimersByTimeAsync(milliseconds - 1)
    expect(app.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
  }
  await work
  expect(app.sent).toHaveLength(1)
})

it('不同群、接入独立计时，私聊无需等待', async () => {
  const app = await prepare()
  const other = app.connect('qq-b', '06', {
    group: { mode: 'whitelist', ids: ['40894918', 'other'] },
    private: { mode: 'whitelist', ids: ['friend'] },
  })
  await other.receive('建立空间')
  await other.receive('建立另一群', { chat: { type: 'group', id: 'other' } })
  await other.receive('建立私聊', { chat: { type: 'private', id: 'friend' } })
  const targets = await Promise.all(
    app.messages.map((message) => app.ctx.im.resolveTarget(message.workspaceId)),
  )
  const first = app.ctx.im.send(targets[0]!, text('两个'))
  const second = app.ctx.im.send(targets[1]!, text('一'))
  const third = app.ctx.im.send(targets[2]!, text('一'))
  await app.ctx.im.send(targets[3]!, text('私聊立即发送'))
  expect(app.sent).toHaveLength(1)
  expect(app.sent[0]?.target.type).toBe('private')
  await vi.advanceTimersByTimeAsync(100)
  await Promise.all([second, third])
  expect(app.sent).toHaveLength(3)
  await vi.advanceTimersByTimeAsync(100)
  await first
  expect(app.sent).toHaveLength(4)
})

it('取消等待不占用幂等键，重试重新等待，已成功的同键不再次计时或发送', async () => {
  const app = await prepare()
  const abort = new AbortController()
  const work = app.ctx.im.send(app.target, text('未发送'), {
    idempotencyKey: 'retry',
    signal: abort.signal,
  })
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(100)
  abort.abort()
  await rejected
  expect(app.sent).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  const retry = app.ctx.im.send(app.target, text('未发送'), { idempotencyKey: 'retry' })
  await vi.advanceTimersByTimeAsync(299)
  expect(app.sent).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  const result = await retry
  expect(app.sent).toHaveLength(1)
  expect(await app.ctx.im.send(app.target, text('未发送'), { idempotencyKey: 'retry' })).toEqual(
    result,
  )
  expect(app.sent).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('等待结束重查聊天策略，拒绝后不会阻塞同群后续消息', async () => {
  const app = await prepare()
  const work = app.ctx.im.send(app.target, text('待发送'), { idempotencyKey: 'policy' })
  const rejected = expect(work).rejects.toThrow('禁用')
  await vi.advanceTimersByTimeAsync(100)
  await app.ctx.im.setPolicy('qq-a', { ...app.defaultPolicy, enabled: false })
  await vi.advanceTimersByTimeAsync(200)
  await rejected
  expect(app.sent).toHaveLength(0)
  await app.ctx.im.setPolicy('qq-a', app.defaultPolicy)
  const retry = app.ctx.im.send(app.target, text('待发送'), { idempotencyKey: 'policy' })
  await vi.advanceTimersByTimeAsync(300)
  await retry
  expect(app.sent).toHaveLength(1)
})

it('IM 服务卸载会取消并等待当前及排队发送，清理所有延迟定时器', async () => {
  const app = await prepare()
  const first = app.ctx.im.send(app.target, text('第一条'), { idempotencyKey: 'first' })
  const second = app.ctx.im.send(app.target, text('第二条'))
  const settled = Promise.allSettled([first, second])
  await vi.advanceTimersByTimeAsync(100)
  expect(vi.getTimerCount()).toBe(1)
  await app.imPlugin.dispose()
  expect((await settled).every((entry) => entry.status === 'rejected')).toBe(true)
  expect(app.sent).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('独立卸载接入取消当前及排队发送，其他接入继续发送', async () => {
  const app = await prepare()
  const owner = await app.ctx.plugin(() => {})
  const send = vi.fn(async () => ({}))
  const handle = app.ctx.im.registerConnection(owner.ctx, {
    id: 'temporary',
    platform: 'qq',
    accountId: '07',
    policy: app.defaultPolicy,
    send,
  })
  await handle.receive({
    id: 'temporary-message',
    chat: app.target.chat,
    sender: { id: 'friend' },
    segments: text('建立空间'),
  })
  const target = await app.ctx.im.resolveTarget(app.messages[1]!.workspaceId)
  const pending = Promise.allSettled([
    app.ctx.im.send(target, text('第一条')),
    app.ctx.im.send(target, text('第二条')),
  ])
  const independent = app.ctx.im.send(app.target, text('其他接入'))
  await vi.advanceTimersByTimeAsync(100)
  await owner.dispose()
  expect((await pending).every((entry) => entry.status === 'rejected')).toBe(true)
  expect(send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(300)
  await independent
  expect(app.sent).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('前一条平台发送完成后才开始下一条计时', async () => {
  const app = await prepare()
  const released = Promise.withResolvers<void>()
  const send = vi.fn(async () => {
    if (send.mock.calls.length === 1) await released.promise
    return {}
  })
  const handle = app.ctx.im.registerConnection(app.ctx, {
    id: 'slow',
    platform: 'qq',
    accountId: '08',
    policy: app.defaultPolicy,
    send,
  })
  await handle.receive({
    id: 'slow-message',
    chat: app.target.chat,
    sender: { id: 'friend' },
    segments: text('建立空间'),
  })
  const target = await app.ctx.im.resolveTarget(app.messages[1]!.workspaceId)
  const first = app.ctx.im.send(target, text('一'))
  const second = app.ctx.im.send(target, text('二'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  released.resolve()
  await first
  await vi.advanceTimersByTimeAsync(99)
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await second
  expect(send).toHaveBeenCalledTimes(2)
})

it('超出单个定时器上限时分段等待，取消会移除剩余定时器', async () => {
  vi.useFakeTimers()
  const abort = new AbortController()
  const work = waitForSend(2 ** 31 + 100, abort.signal)
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(2 ** 31 - 1)
  expect(vi.getTimerCount()).toBe(1)
  abort.abort()
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

async function prepareAi() {
  const app = await setup({
    ai: true,
    deliveryAttempts: 1,
    imConfig: {},
    driver: {
      id: 'driver',
      async generate() {
        return {
          content: [
            {
              type: 'text',
              text: '<im_reply><message>这是第一条消息</message><message>这是第二条消息</message></im_reply>',
            },
          ],
        }
      },
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  await app.connection.receive('/ai 回复')
  // expect.poll 会推进虚拟时间；这里只等待模型完成，保持发送计时的起点不变。
  for (let attempt = 0; attempt < 500 && !vi.getTimerCount(); attempt++) await realDelay(1)
  expect(vi.getTimerCount()).toBe(1)
  return app
}

it('AI 的两条 message 在生成后逐条延迟，不先等待整份回复', async () => {
  const app = await prepareAi()
  await vi.advanceTimersByTimeAsync(699)
  expect(app.sent).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(app.sent.map((entry) => entry.segments)).toEqual([text('这是第一条消息')])
  await vi.advanceTimersByTimeAsync(699)
  expect(app.sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.sent.map((entry) => entry.segments)).toEqual([
    text('这是第一条消息'),
    text('这是第二条消息'),
  ])
})

it.each(['/stop', '/reset'])('%s 立即取消等待中的 AI 回复及其后续消息', async (command) => {
  const app = await prepareAi()
  await vi.advanceTimersByTimeAsync(100)
  const stopping = app.connection.receive(command)
  // 命令先取消 AI 等待；随后命令自身的回复继续遵守群聊发送延迟。
  await poll(async () => (await app.jobs())[0]?.status).toBe('cancelled')
  await vi.advanceTimersByTimeAsync(10000)
  await stopping
  expect(app.sent).toHaveLength(1)
  expect(JSON.stringify(app.sent)).not.toContain('这是第一条消息')
  expect(JSON.stringify(app.sent)).not.toContain('这是第二条消息')
  expect((await app.jobs())[0]?.delivery).toBe('sent')
  expect(vi.getTimerCount()).toBe(0)
})

it('独立卸载 AI 插件会取消发送延迟，仍保留可恢复的待投递回复', async () => {
  const app = await prepareAi()
  await app.aiPlugin!.dispose()
  expect(app.sent).toHaveLength(0)
  expect((await app.jobs())[0]?.delivery).toBe('pending')
  expect((await app.jobs())[0]?.attempts).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  for (let attempt = 0; attempt < 1000 && !vi.getTimerCount(); attempt++) await realDelay(1)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1400)
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.sent.map((entry) => entry.segments)).toEqual([
    text('这是第一条消息'),
    text('这是第二条消息'),
  ])
})

it('等待期间关闭 AI 后不发送已经生成的回复', async () => {
  const app = await prepareAi()
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { ai: false } },
  })
  await vi.advanceTimersByTimeAsync(700)
  await poll(async () => (await app.jobs())[0]?.delivery).not.toBe('pending')
  expect(app.sent).toHaveLength(0)
})
