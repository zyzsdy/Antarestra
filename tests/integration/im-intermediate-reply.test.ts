import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import imAi from '@antarestra/plugin-im-ai'
import { intermediateTexts } from '../../plugins/features/im-ai/src/messages.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
})
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })

async function slowTool(rounds = 1, text = '我查一下官方发售时间') {
  let calls = 0
  let release!: () => void
  const app = await setup({
    ai: true,
    toolIds: ['slow'],
    driver: {
      id: 'driver',
      async generate(_request, _connection, _context, update) {
        calls++
        await update({ type: 'delta', kind: 'text', text: '不应单独转发的增量' })
        return {
          content:
            calls <= rounds
              ? [
                  { type: 'thinking', text: '不应转发的思考' },
                  { type: 'text', text },
                  { type: 'tool-call', id: `call-${calls}`, name: 'slow', arguments: {} },
                ]
              : [{ type: 'text', text: '<im_reply><message>最终回答</message></im_reply>' }],
        }
      },
    },
  })
  app.ctx.ai.registerTool(app.ctx, {
    id: 'slow',
    description: '等待测试放行的工具',
    parameters: { type: 'object', properties: {} },
    async execute(_args, context) {
      const gate = new AbortController()
      release = () => gate.abort()
      await delay(60000, undefined, {
        signal: AbortSignal.any([gate.signal, context.signal]),
      }).catch(() => context.signal.throwIfAborted())
      return '不应转发的工具结果'
    },
  })
  return { ...app, release: () => release(), calls: () => calls }
}

it('长工具运行期间发送完整中间正文，多轮按顺序投递且不重复最终回复', async () => {
  const app = await slowTool(2)
  await app.connection.receive('/ai 查询', { id: 'original' })
  await poll(() => app.sent.length).toBe(1)
  expect((await app.jobs())[0]?.status).toBe('running')
  expect(app.calls()).toBe(1)
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '我查一下官方发售时间' }])
  app.release()
  await poll(() => app.sent.length).toBe(2)
  expect(app.calls()).toBe(2)
  app.release()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  await app.connection.receive('/ai 查询', { id: 'original' })
  expect(app.sent.map((message) => message.segments)).toEqual([
    [{ type: 'text', text: '我查一下官方发售时间' }],
    [{ type: 'text', text: '我查一下官方发售时间' }],
    [{ type: 'text', text: '最终回答' }],
  ])
  expect(app.calls()).toBe(3)
})

it('中间正文按普通文本发送，不要求或解析 IM 消息标签', async () => {
  const text = '正在查询 <message>未闭合标签 & 原始文本'
  const app = await slowTool(1, text)
  await app.connection.receive('/ai 查询')
  await poll(() => app.sent.length).toBe(1)
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text }])
  app.release()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.sent).toHaveLength(2)
})

it('识别 commentary 正文，忽略空白、思考、工具结果与未完整生成的消息', () => {
  expect(
    intermediateTexts({
      messages: [
        {
          id: 'truncated',
          role: 'assistant',
          stopReason: 'length',
          content: [{ type: 'text', text: '截断回复' }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', id: 't', content: '内部结果', isError: false }],
        },
        { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
        {
          id: 'commentary',
          role: 'assistant',
          content: [
            { type: 'thinking', text: '内部思考' },
            {
              type: 'text',
              text: '继续查询',
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
  ).toEqual([{ id: 'commentary', text: '继续查询' }])
})

it('中间回复发送结果未知不重试、不取消工具，最终回复仍可投递', async () => {
  const app = await slowTool()
  const send = vi.spyOn(app.ctx.im, 'send')
  app.setSendError(new Error('平台超时'))
  await app.connection.receive('/ai 查询')
  await poll(() => send.mock.settledResults[0]?.type).toBe('rejected')
  expect(app.calls()).toBe(1)
  app.setSendError()
  app.release()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(send).toHaveBeenCalledTimes(2)
  expect(app.sent.map((message) => message.segments)).toEqual([
    [{ type: 'text', text: '最终回答' }],
  ])
})

it('恢复已完成运行不重复发送中间正文或最终回复，也不重跑模型', async () => {
  const app = await slowTool()
  await app.connection.receive('/ai 查询')
  await poll(() => app.sent.length).toBe(1)
  app.release()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  const job = (await app.jobs())[0]!
  await app.aiPlugin!.dispose()
  await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .updateTable('jobs')
    .set({ status: 'running', delivery: 'pending', answer: null, reply_plan: null })
    .where('id', '=', job.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.calls()).toBe(2)
  expect(app.sent).toHaveLength(2)
})

it.each(['stop', 'unload', 'disable'] as const)(
  '中间回复发送后 %s 阻止后续回复并清理运行',
  async (action) => {
    const app = await slowTool(2)
    await app.connection.receive('/ai 查询')
    await poll(() => app.sent.length).toBe(1)
    if (action === 'stop') await app.connection.receive('/stop')
    else if (action === 'unload') await app.aiPlugin!.dispose()
    else {
      await app.ctx.im.setPolicy('qq-a', {
        ...app.defaultPolicy,
        chats: { 'group:40894918': { ai: false } },
      })
      await poll(() => app.ctx.ai.running.size).toBe(0)
    }
    expect(app.ctx.ai.running.size).toBe(0)
    expect(app.calls()).toBe(1)
    expect(app.sent).toHaveLength(action === 'stop' ? 2 : 1)
  },
)
