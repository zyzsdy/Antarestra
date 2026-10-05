import { afterEach, expect, it, vi } from 'vitest'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { validateConnectionPolicy } from '@antarestra/im'
import imAi from '@antarestra/plugin-im-ai'
import {
  dynamicReplyProbability,
  recordDynamicActivation,
  recordDynamicReply,
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
])('适配器 %s 的主配置不再接受 policy，动态回复由 IM 规则校验', (adapter, credentials) => {
  const schema = new URL(`../../plugins/adapters/${adapter}/config.schema.json`, import.meta.url)
  const policy = { defaults: { activation: { dynamic: { maxSilentMessages: 150 } } } }
  expect(schemaConfig(schema, credentials)).toMatchObject(credentials)
  expect(() => schemaConfig(schema, { ...credentials, policy })).toThrow()
  expect(validateConnectionPolicy(policy)).toEqual(policy)
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

it('入队仅重置基础概率，有效回复才启动热点，窗口内回复不续期', () => {
  const state: DynamicReplyState = { silentMessages: 50 }
  recordDynamicActivation(state)
  expect(state.silentMessages).toBe(0)
  expect(dynamicReplyProbability({}, state, 1000)).toBe(0.002)
  recordDynamicReply({}, state, 1000, true)
  expect(dynamicReplyProbability({}, state, 1000)).toBeCloseTo(0.2)
  const early = dynamicReplyProbability({}, state, 31000)
  recordDynamicActivation(state)
  recordDynamicReply({}, state, 31000, true)
  expect(state.hotStartedAt).toBe(1000)
  expect(dynamicReplyProbability({}, state, 61000)).toBeLessThan(early)
  expect(dynamicReplyProbability({}, state, 121000)).toBe(0.002)
  recordDynamicReply({}, state, 122000, true)
  expect(state.hotStartedAt).toBe(122000)
})

it('自主沉默清除已有热点，保留模型运行期间累计的基础概率', () => {
  const state: DynamicReplyState = { silentMessages: 0, hotStartedAt: 1000 }
  recordDynamicActivation(state)
  state.silentMessages = 75
  recordDynamicReply({}, state, 2000, false)
  expect(state).toEqual({ silentMessages: 75 })
  expect(dynamicReplyProbability({}, state, 2000)).toBe(
    dynamicReplyProbability({}, { silentMessages: 75 }, 2000),
  )
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

it('普通 all 组合保持语义，动态条件独立或匹配；普通激活后的有效回复也启动热点', async () => {
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

it('模型决定回复前不提前开启热点，也不清零运行期间新增的消息计数', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        calls++
        await gate.promise
        return { content: [{ type: 'text', text: '<message></message>' }] }
      },
    },
  })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: {
      activation: {
        prefixes: ['/ai'],
        dynamic: { baseProbability: 0, hotProbability: 1, maxSilentMessages: 4 },
      },
    },
  })
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  try {
    await app.connection.receive('/ai 触发')
    await poll(() => calls).toBe(1)
    await app.connection.receive('与 AI 无关的一')
    await app.connection.receive('与 AI 无关的二')
    expect(await app.jobs()).toHaveLength(1)
  } finally {
    gate.resolve()
  }
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  await app.connection.receive('与 AI 无关的三')
  expect(await app.jobs()).toHaveLength(1)
  await app.connection.receive('基础概率达到第四条阈值')
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(2)
  expect(app.sent).toHaveLength(0)
})

it.each(['<message></message>', '<im_reply><message> </message></im_reply>', ''])(
  '空回复不启动热点且清除旧热点，基础概率继续递增，之后非空回复可重新升温：%s',
  async (silence) => {
    let answer = silence
    const app = await setup({
      ai: true,
      driver: {
        id: 'driver',
        async generate() {
          return { content: [{ type: 'text', text: answer }] }
        },
      },
    })
    const policy = {
      ...app.defaultPolicy,
      defaults: {
        activation: {
          prefixes: ['/ai'],
          dynamic: { baseProbability: 0, hotProbability: 1, maxSilentMessages: 4 },
        },
      },
    }
    await app.ctx.im.setPolicy('qq-a', policy)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await app.connection.receive('/ai 与 AI 无关')
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    expect(app.sent).toHaveLength(0)
    for (let n = 1; n <= 3; n++) await app.connection.receive(`普通闲聊 ${n}`)
    expect(await app.jobs()).toHaveLength(1)

    // 空白标签与非空内容混合时，非空内容仍能开启热点。
    answer = '<im_reply><message></message><message>参与话题</message></im_reply>'
    await app.connection.receive('基础概率到达阈值')
    await poll(() => app.sent.length).toBe(1)
    answer = silence
    await app.connection.receive('热点触发，但模型选择沉默')
    await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(
      3,
    )
    expect(app.sent).toHaveLength(1)

    for (let n = 1; n <= 3; n++) await app.connection.receive(`退回基础概率 ${n}`)
    expect(await app.jobs()).toHaveLength(3)
    answer = '重新参与'
    await app.connection.receive('再次到达基础阈值')
    await poll(() => app.sent.length).toBe(2)
    await app.connection.receive('重新开启热点后接话')
    await poll(() => app.sent.length).toBe(3)
  },
)

it.each(['模型失败', '格式错误'] as const)('%s 的错误提示不会开启热点', async (failure) => {
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        if (failure === '模型失败') throw new Error('测试模型失败')
        return { content: [{ type: 'text', text: '<im_reply><image></image></im_reply>' }] }
      },
    },
  })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: {
      activation: {
        prefixes: ['/ai'],
        dynamic: { baseProbability: 0, hotProbability: 1 },
      },
    },
  })
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  await app.connection.receive('/ai 触发失败')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect((await app.jobs())[0]?.status).toBe('failed')
  expect(app.sent).toHaveLength(1)
  await app.connection.receive('普通闲聊不因错误提示升温')
  expect(await app.jobs()).toHaveLength(1)
})

it('一个账号自主沉默时，不清除另一个账号的热点', async () => {
  let answer = '参与话题'
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return { content: [{ type: 'text', text: answer }] }
      },
    },
  })
  const policy = {
    ...app.defaultPolicy,
    defaults: {
      activation: {
        prefixes: ['/ai'],
        dynamic: { baseProbability: 0, hotProbability: 1 },
      },
    },
  }
  await app.ctx.im.setPolicy('qq-a', policy)
  const other = await app.connect('qq-b', '06', policy)
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  await app.connection.receive('/ai 第一个账号')
  await poll(() => app.sent.length).toBe(1)
  await other.receive('/ai 第二个账号')
  await poll(() => app.sent.length).toBe(2)
  answer = '<message></message>'
  await app.connection.receive('第一个账号选择沉默')
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(3)
  await app.connection.receive('第一个账号已无热点')
  expect(await app.jobs()).toHaveLength(3)
  answer = '第二个账号仍在接话'
  await other.receive('第二个账号仍有热点')
  await poll(() => app.sent.length).toBe(3)
  expect(app.sent[2]?.connection).toBe('qq-b')
})

it('主动发送不被激活条件拦截、不清零沉默、不开启热点，双账号状态独立', async () => {
  const app = await setup({ ai: true })
  const dynamic = { maxSilentMessages: 3 }
  const policy = { ...app.defaultPolicy, defaults: { activation: { dynamic } } }
  await app.ctx.im.setPolicy('qq-a', policy)
  const other = await app.connect('qq-b', '06', policy)
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
  const privateChat = await app.connect('private', '07', {
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
