import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { finalText } from '@antarestra/plugin-im-ai'
import imAi from '@antarestra/plugin-im-ai'
import { pluginId } from '../../plugins/features/im-ai/src/store.js'
import type { Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })

it('闲聊、命令、不相关 @、禁用聊天不调用模型，只发送最终正文', async () => {
  const app = await setup({ ai: true })
  await app.connection.receive('群里闲聊')
  await app.connection.receive('/ping')
  await app.connection.receive('问别人', {
    segments: [
      { type: 'mention', userId: '06' },
      { type: 'text', text: '问别人' },
    ],
  })
  await app.connection.receive('/ai 私聊', { chat: { type: 'private', id: '79338528' } })
  expect(app.aiState.calls).toBe(0)
  expect(await app.jobs()).toEqual([])
  await app.connection.receive('问题', {
    segments: [
      { type: 'mention', userId: '05' },
      { type: 'text', text: '问题' },
    ],
  })
  await poll(() => app.sent.length).toBe(2)
  expect(app.aiState.calls).toBe(1)
  expect(app.sent[1]?.segments).toEqual([{ type: 'text', text: '最终回答' }])
  expect((await app.jobs())[0]?.input).toContain('群里闲聊')
})

it('截断回复标记失败并发送未完整生成提示，不投递残缺正文', async () => {
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return { content: [{ type: 'text', text: '残缺正文' }], stopReason: 'length' }
      },
    },
  })
  await app.connection.receive('/ai 问题')
  await poll(() => app.sent.length).toBe(1)
  expect((await app.jobs())[0]?.status).toBe('failed')
  expect(app.sent[0]?.segments).toEqual([
    {
      type: 'text',
      text: '模型达到输出上限，回复未完整生成。请使用 /reset 开始新的对话后重试。',
    },
  ])
})

it('同群不同发言者共用会话并保持各自授权，双账号同群隔离且重复消息只运行一次', async () => {
  const app = await setup({ ai: true })
  await app.connection.receive('/ai 第一条', { id: 'stable-message' })
  await poll(() => app.sent.length).toBe(1)
  await app.connection.receive('/ai 第二条', { sender: { id: 'other', name: '另一成员' } })
  await poll(() => app.sent.length).toBe(2)
  const second = await app.connect('qq-b', '06')
  await second.receive('/ai 独立空间')
  await poll(() => app.sent.length).toBe(3)
  await app.connection.receive('/ai 第一条', { id: 'stable-message' })
  const jobs = await app.jobs()
  expect(jobs).toHaveLength(3)
  expect(jobs[0]?.conversation_id).toBe(jobs[1]?.conversation_id)
  expect(jobs[0]?.actor_id).not.toBe(jobs[1]?.actor_id)
  expect(jobs[0]?.workspace_id).not.toBe(jobs[2]?.workspace_id)
  expect(jobs[0]?.conversation_id).not.toBe(jobs[2]?.conversation_id)
  expect(app.sent.map((sent) => sent.connection)).toEqual(['qq-a', 'qq-a', 'qq-b'])
  const access = await app.ctx.ai.authorize('im', app.messages[1]!.request)
  const record = await app.ctx.ai.getRun(access, jobs[1]!.run_id!)
  expect(record.actorId).toBe(jobs[1]?.actor_id)
  expect(record.input.text).toContain('另一成员')
  expect(app.aiState.calls).toBe(3)
})

it('每空间有限串行队列，普通命令和 stop 不被正在运行的模型阻塞', async () => {
  let calls = 0
  const app = await setup({
    ai: true,
    queueLimit: 1,
    driver: {
      id: 'driver',
      async generate(_request, _connection, context) {
        calls++
        await delay(60000, undefined, { signal: context.signal })
        return { content: [{ type: 'text', text: '不应完成' }] }
      },
    },
  })
  await app.connection.receive('/ai 第一条')
  await poll(() => calls).toBe(1)
  await app.connection.receive('/ai 排队')
  await app.connection.receive('/ai 超出队列')
  await app.connection.receive('/ping')
  expect(JSON.stringify(app.sent)).toContain('pong')
  expect(JSON.stringify(app.sent)).toContain('等待消息较多')
  await app.connection.receive('/stop')
  expect(app.ctx.ai.running.size).toBe(0)
  expect(calls).toBe(1)
  expect(
    (await app.jobs()).every((job) => job.status !== 'queued' && job.status !== 'running'),
  ).toBe(true)
})

it('排队消息执行前重新检查最新 AI 启用状态', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        calls++
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { content: [{ type: 'text', text: '不会投递' }] }
      },
    },
  })
  await app.connection.receive('/ai 第一条')
  await poll(() => calls).toBe(1)
  await app.connection.receive('/ai 排队')
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { ai: false } },
  })
  release!()
  await poll(async () => (await app.jobs()).every((job) => job.delivery !== 'pending')).toBe(true)
  expect(calls).toBe(1)
  expect(app.sent).toHaveLength(0)
})

it('切换 Agent 与 reset 在原空间开启新会话，历史保留', async () => {
  const app = await setup({ ai: true })
  await app.connection.receive('/ai 第一条')
  await poll(() => app.sent.length).toBe(1)
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { agentId: 'second' } },
  })
  await app.connection.receive('/ai 第二条')
  await poll(() => app.sent.length).toBe(2)
  await app.connection.receive('/reset')
  await app.connection.receive('/ai 第三条')
  await poll(() => app.sent.length).toBe(4)
  const jobs = await app.jobs()
  expect(new Set(jobs.map((job) => job.workspace_id)).size).toBe(1)
  expect(new Set(jobs.map((job) => job.conversation_id)).size).toBe(3)
  const access = await app.ctx.ai.authorize('im', app.messages[0]!.request)
  expect(
    (await app.ctx.ai.getConversation(access, jobs[0]!.conversation_id!)).conversation.agentId,
  ).toBe('assistant')
  expect(
    (await app.ctx.ai.getConversation(access, jobs[1]!.conversation_id!)).conversation.agentId,
  ).toBe('second')
})

it('投递结果未知时不重复发送、不重跑模型；插件重载沿用当前空间会话', async () => {
  const app = await setup({ ai: true })
  app.setSendError(new Error('平台发送超时'))
  await app.connection.receive('/ai 第一次')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('unknown')
  expect(app.aiState.calls).toBe(1)
  const first = (await app.jobs())[0]!
  await app.aiPlugin!.dispose()
  app.setSendError()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await app.connection.receive('/ai 第二次')
  await poll(() => app.sent.length).toBe(1)
  const jobs = await app.jobs()
  expect(jobs[1]?.conversation_id).toBe(first.conversation_id)
  expect(app.aiState.calls).toBe(2)
})

it('卸载取消活动模型并回收 stop/reset，普通命令仍可工作', async () => {
  let calls = 0
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate(_request, _connection, context) {
        calls++
        await delay(60000, undefined, { signal: context.signal })
        return { content: [{ type: 'text', text: '不应完成' }] }
      },
    },
  })
  await app.connection.receive('/ai 第一条')
  await poll(() => calls).toBe(1)
  await app.aiPlugin!.dispose()
  expect(app.ctx.ai.running.size).toBe(0)
  await app.connection.receive('/ping')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: 'pong' }])
})

it('最终正文不包含中途文字、工具结果或思考', () => {
  expect(
    finalText({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '中途说明' },
            { type: 'thinking', text: '思考' },
            { type: 'tool-call', id: 't', name: 't', arguments: {} },
            { type: 'text', text: '最后回答' },
          ],
        },
      ],
    }),
  ).toBe('最后回答')
  expect(
    finalText({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '执行前说明',
              continuation: {
                model: { providerId: 'provider', modelId: 'model' },
                driverId: 'driver',
                signature: JSON.stringify({ v: 1, phase: 'commentary' }),
              },
            },
            { type: 'text', text: '最终正文' },
          ],
        },
      ],
    }),
  ).toBe('最终正文')
})

it('Agent 配置不可用时回复通用错误，不泄露内部错误详情', async () => {
  const app = await setup({ ai: true })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { agentId: 'unknown-secret-agent' } },
  })
  await app.connection.receive('/ai 问题')
  await poll(() => app.sent.length).toBe(1)
  expect(JSON.stringify(app.sent)).toContain('AI 暂时无法处理')
  expect(JSON.stringify(app.sent)).not.toContain('unknown-secret-agent')
  expect(app.aiState.calls).toBe(0)
})

it('原始命令持久化后可以恢复未保存 run_id 的消息，不再次调用模型', async () => {
  const app = await setup({ ai: true })
  await app.connection.receive('/ai 首次请求')
  await poll(() => app.sent.length).toBe(1)
  const original = (await app.jobs())[0]!
  await app.aiPlugin!.dispose()
  await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .updateTable('jobs')
    .set({ status: 'running', run_id: null, answer: null, delivery: 'pending' })
    .where('id', '=', original.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect((await app.jobs())[0]?.run_id).toBe(original.run_id)
  expect(app.aiState.calls).toBe(1)
  expect(app.sent).toHaveLength(1)
})

it('组合激活条件、冷却与近期缓冲按群策略执行', async () => {
  const app = await setup({ ai: true })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: {
      'group:40894918': {
        userInputTemplate: '{{history_message}}',
        historyLimit: 2,
        activation: { mode: 'all', mention: true, keywords: ['问题'], cooldownMs: 60000 },
      },
    },
  })
  await app.connection.receive('较早闲聊')
  await app.connection.receive('最近闲聊')
  await app.connection.receive('问题', {
    segments: [
      { type: 'mention', userId: '05' },
      { type: 'text', text: '问题' },
    ],
  })
  await poll(() => app.sent.length).toBe(1)
  expect((await app.jobs())[0]?.input).toContain('最近闲聊')
  expect((await app.jobs())[0]?.input).not.toContain('较早闲聊')
  await app.connection.receive('问题', {
    segments: [
      { type: 'mention', userId: '05' },
      { type: 'text', text: '问题' },
    ],
  })
  expect(await app.jobs()).toHaveLength(1)
})

it('超过一分钟的冷却不会随每分钟计数清理提前结束', async () => {
  const app = await setup({ ai: true })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { activation: { prefixes: ['/ai'], cooldownMs: 120000 } } },
  })
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    await app.connection.receive('/ai 第一次')
    await poll(() => app.sent.length).toBe(1)
    now += 61000
    await app.connection.receive('/ai 仍在冷却')
    expect(await app.jobs()).toHaveLength(1)
    now += 60000
    await app.connection.receive('/ai 冷却结束')
    await poll(() => app.sent.length).toBe(2)
  } finally {
    clock.mockRestore()
  }
})
