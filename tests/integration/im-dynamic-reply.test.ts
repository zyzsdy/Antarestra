import { afterEach, expect, it, vi } from 'vitest'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { validateConnectionPolicy } from '@antarestra/im'
import imAi from '@antarestra/plugin-im-ai'
import {
  dynamicReplyProbability,
  recordDynamicActivation,
} from '../../plugins/features/im-ai/src/dynamic-reply.js'
import type { DynamicReplyState } from '../../plugins/features/im-ai/src/dynamic-reply.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })

it.each([
  ['im-onebot', { id: 'test', selfId: '123', token: 'test-only' }],
  [
    'im-feishu',
    { id: 'test', appId: 'app', appSecret: 'test-only', tenantId: 'tenant', botOpenId: 'bot' },
  ],
])('适配器 %s 的主配置接受动态回复并拒绝越界参数', (adapter, credentials) => {
  const schema = new URL(`../../plugins/adapters/${adapter}/config.schema.json`, import.meta.url)
  const policy = { defaults: { activation: { dynamic: { maxSilentMessages: 150 } } } }
  expect(schemaConfig(schema, { ...credentials, policy })).toMatchObject({ policy })
  expect(() =>
    schemaConfig(schema, {
      ...credentials,
      policy: {
        defaults: { activation: { dynamic: { baseProbability: 2 } } },
      },
    }),
  ).toThrow()
})

it('默认概率前期极低、后期指数上升，在第 150 条精确达到 100%', () => {
  const p = (n: number) => dynamicReplyProbability({}, { silentMessages: n }, 0)
  expect(p(0)).toBe(0.002)
  expect(p(30)).toBeLessThan(0.003)
  expect(p(75)).toBeLessThan(0.009)
  expect(p(120)).toBeGreaterThan(0.13)
  expect(p(149)).toBeLessThan(1)
  expect(p(150)).toBe(1)
  expect(p(999)).toBe(1)
  for (let n = 1; n <= 150; n++) expect(p(n)).toBeGreaterThan(p(n - 1))
})

it('热点随时间平滑衰减，窗口内反复激活不续期，结束后可开启新话题', () => {
  const state: DynamicReplyState = { silentMessages: 50 }
  recordDynamicActivation({}, state, 1000)
  expect(state.silentMessages).toBe(0)
  expect(dynamicReplyProbability({}, state, 1000)).toBeCloseTo(0.2)
  const early = dynamicReplyProbability({}, state, 31000)
  recordDynamicActivation({}, state, 31000)
  expect(state.hotStartedAt).toBe(1000)
  expect(dynamicReplyProbability({}, state, 61000)).toBeLessThan(early)
  expect(dynamicReplyProbability({}, state, 121000)).toBe(0.002)
  recordDynamicActivation({}, state, 122000)
  expect(state.hotStartedAt).toBe(122000)
})

it.each([
  { baseProbability: -0.1 },
  { hotProbability: 1.01 },
  { hotDurationMs: 0 },
  { maxSilentMessages: 0 },
  { maxSilentMessages: 1.5 },
])('拒绝无效动态配置 %j', (dynamic) => {
  expect(() => validateConnectionPolicy({ defaults: { activation: { dynamic } } })).toThrow()
})

it('动态配置可单独启用并持久化，第 N 条入队后重新计数，重复/机器人/空文本/命令不计数', async () => {
  const app = await setup({ ai: true })
  const policy = {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { activation: { dynamic: { maxSilentMessages: 3 } } } },
  }
  await app.ctx.im.setPolicy('qq-a', policy)
  expect(app.ctx.im.getPolicy('qq-a')).toEqual(policy)
  vi.spyOn(Math, 'random').mockReturnValue(0.999999)
  await app.connection.receive('第一条', { id: 'same' })
  await app.connection.receive('重复', { id: 'same' })
  await app.connection.receive('自己', { sender: { id: '05' } })
  await app.connection.receive('其他机器人', { sender: { id: 'bot', bot: true } })
  await app.connection.receive('   ')
  await app.connection.receive('/ping')
  await app.connection.receive('第二条')
  expect(await app.jobs()).toHaveLength(0)
  await app.connection.receive('第三条')
  await poll(() => app.aiState.calls).toBe(1)
  await app.connection.receive('重新计数')
  expect(await app.jobs()).toHaveLength(1)
})

it('普通 all 组合保持语义，动态条件独立或匹配；普通激活也重置沉默并启动热点', async () => {
  const app = await setup({ ai: true })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: {
      'group:40894918': {
        activation: {
          mode: 'all',
          mention: true,
          keywords: ['问题'],
          dynamic: { maxSilentMessages: 3 },
        },
      },
    },
  })
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999)
  await app.connection.receive('问题')
  expect(await app.jobs()).toHaveLength(0)
  await app.connection.receive('问题', {
    segments: [
      { type: 'mention', userId: '05' },
      { type: 'text', text: '问题' },
    ],
  })
  await poll(() => app.sent.length).toBe(1)
  random.mockReturnValue(0.05)
  await app.connection.receive('接话')
  await poll(() => app.sent.length).toBe(2)
  random.mockReturnValue(0.999999)
  await app.connection.receive('普通文字一')
  await app.connection.receive('普通文字二')
  expect(await app.jobs()).toHaveLength(2)
  await app.connection.receive('普通文字三')
  expect(await app.jobs()).toHaveLength(3)
})

it('主动发送不被激活条件拦截、不清零沉默、不开启热点，双账号状态独立', async () => {
  const app = await setup({ ai: true })
  const dynamic = { maxSilentMessages: 3 }
  const policy = { ...app.defaultPolicy, defaults: { activation: { dynamic } } }
  await app.ctx.im.setPolicy('qq-a', policy)
  const other = app.connect('qq-b', '06', policy)
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999)
  await app.connection.receive('第一条')
  await other.receive('其他账号第一条')
  await app.ctx.im.send(
    {
      connectionId: 'qq-a',
      chat: { type: 'group', id: '40894918' },
      workspaceId: app.messages[0]!.workspaceId,
    },
    [{ type: 'text', text: '主动通知' }],
  )
  expect(app.sent).toHaveLength(1)
  random.mockReturnValue(0.05)
  await app.connection.receive('没有被主动通知加热')
  expect(await app.jobs()).toHaveLength(0)
  random.mockReturnValue(0.999999)
  await app.connection.receive('第三条仍命中')
  await other.receive('其他账号第二条')
  expect(await app.jobs()).toHaveLength(1)
})

it('冷却拦截后保留阈值，冷却结束即激活；卸载重载清理动态状态', async () => {
  const app = await setup({ ai: true })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: {
      activation: { cooldownMs: 60000, dynamic: { maxSilentMessages: 2 } },
    },
  })
  vi.spyOn(Math, 'random').mockReturnValue(0.999999)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  await app.connection.receive('第一条')
  await app.connection.receive('第二条')
  await poll(() => app.sent.length).toBe(1)
  await app.connection.receive('冷却一')
  await app.connection.receive('冷却二')
  expect(await app.jobs()).toHaveLength(1)
  now += 60001
  await app.connection.receive('冷却后无需重新累计')
  await poll(() => app.sent.length).toBe(2)
  await app.connection.receive('累计一条')
  await app.aiPlugin!.dispose()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await app.connection.receive('重载后第一条')
  expect(await app.jobs()).toHaveLength(2)
})

it('私聊不使用群聊动态条件，按原有普通条件判断', async () => {
  const app = await setup({ ai: true })
  const privateChat = app.connect('private', '07', {
    private: {
      mode: 'blacklist',
      ids: [],
      defaults: {
        ai: true,
        activation: { keywords: ['问题'], dynamic: { baseProbability: 1, maxSilentMessages: 1 } },
      },
    },
  })
  await privateChat.receive('闲聊', { chat: { type: 'private', id: 'user' } })
  expect(await app.jobs()).toHaveLength(0)
  await privateChat.receive('问题', { chat: { type: 'private', id: 'user' } })
  expect(await app.jobs()).toHaveLength(1)
})
