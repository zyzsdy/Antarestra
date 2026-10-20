import { afterEach, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import wakeTasks from '@antarestra/plugin-wake-tasks'
import imAi from '@antarestra/plugin-im-ai'
import type { ModelDriver } from '@antarestra/ai'
import { cleanup, setup } from './im-features-fixture.js'
import { pluginId } from '../../plugins/features/wake-tasks/src/store.js'
import type { Tables } from '../../plugins/features/wake-tasks/src/store.js'

afterEach(cleanup)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 7000, interval: 20 })
const prompt = '提醒下楼拿快递，保留原文 {{last_message}}。'
const config = { pollIntervalMs: 100, leaseMs: 3000 }

async function reminder(
  userTemplate = '{{active_reason}}\n{{history_message}}\n{{last_message}}\n{{im_status}}',
  blockWake = false,
) {
  let planned = false
  const requests: Parameters<ModelDriver['generate']>[0][] = []
  const app = await setup({
    ai: true,
    userTemplate,
    toolIds: ['wake_task_create'],
    driver: {
      id: 'driver',
      async generate(request, _connection, context) {
        requests.push(request)
        if (blockWake && requests.length === 3)
          await delay(60000, undefined, { signal: context.signal })
        if (!planned) {
          planned = true
          return {
            content: [
              {
                type: 'tool-call',
                id: 'schedule',
                name: 'wake_task_create',
                arguments: {
                  triggerAt: new Date(Date.now() + 3600000).toISOString(),
                  reason: '快递提醒',
                  prompt,
                },
              },
            ],
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: '<im_reply><status>提醒状态</status><message>快递提醒</message></im_reply>',
            },
          ],
        }
      },
    },
  })
  const plugin = await app.ctx.plugin(wakeTasks, config)
  await app.connection.receive('普通聊天背景')
  await app.connection.receive('/ai 安排提醒')
  await poll(() => app.sent.length).toBe(1)
  const db = app.ctx.database.scope<Tables>(app.ctx, pluginId)
  const task = await db.selectFrom('tasks').selectAll().executeTakeFirstOrThrow()
  const row = () =>
    db.selectFrom('tasks').selectAll().where('id', '=', task.id).executeTakeFirstOrThrow()
  const due = () =>
    db
      .updateTable('tasks')
      .set({ next_at: Date.now() - 1, available_at: Date.now() - 1 })
      .where('id', '=', task.id)
      .execute()
  return { ...app, plugin, db, task, row, due, requests }
}

it('IM 唤醒复用输入变量及原助理，在独立会话执行并投递到原连接原群', async () => {
  const app = await reminder()
  await app.connect('qq-b', '06')
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { agentId: 'second' } },
  })
  await app.due()
  await poll(async () => (await app.row()).status).toBe('completed')
  expect(app.sent).toHaveLength(2)
  expect(app.sent[1]).toMatchObject({
    connection: 'qq-a',
    target: { type: 'group', id: '40894918' },
    segments: [{ type: 'text', text: '快递提醒' }],
  })
  const jobs = await app.jobs()
  expect(jobs).toHaveLength(2)
  const job = jobs.find((item) => item.id.startsWith('wake:'))!
  const lastMessage = `本次为定时激活唤醒，计划任务创建时的信息为：\n${app.task.prompt}\n请按照此消息进行定时任务的执行。`
  expect(JSON.parse(job.snapshot!).last_message).toBe(lastMessage)
  expect(job.input).toContain(lastMessage)
  expect(job.delivery).toBe('sent')
  expect(job.conversation_id).not.toBe(app.task.source_conversation_id)
  const access = await app.ctx.ai.authorize('im', app.messages[0]!.request)
  const run = await app.ctx.ai.getRun(access, job.run_id!)
  expect(run.agent.id).toBe('assistant')
  expect(run.messages[0]?.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(lastMessage),
      }),
    ]),
  )
  const actual = JSON.stringify(app.requests.at(-1)?.messages)
  expect(actual).toContain('定时唤醒：快递提醒')
  expect(actual).toContain('普通聊天背景')
  expect(actual).toContain('提醒状态')
  await app.ctx.wakeTasks.tick()
  expect(app.sent).toHaveLength(2)
})

it('自定义模板完全未引用输入时仍保留完整任务指令', async () => {
  const app = await reminder('固定模板')
  await app.due()
  await poll(async () => (await app.row()).status).toBe('completed')
  const actual = JSON.stringify(app.requests.at(-1)?.messages)
  expect(actual).toContain(prompt)
  expect(actual).toContain('定时任务指令')
})

it('来源处理器未加载时重试，恢复后执行且不退回普通 AI 会话', async () => {
  const app = await reminder()
  await app.aiPlugin!.dispose()
  await app.due()
  await poll(async () => (await app.row()).attempts).toBe(1)
  expect((await app.row()).last_run_id).toBeNull()
  expect(app.requests).toHaveLength(2)
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await poll(async () => (await app.row()).status).toBe('completed')
  expect(app.sent).toHaveLength(2)
})

it('离线排队、插件重载和重复交接只执行及发送一次', async () => {
  const app = await reminder()
  app.connection.handle.setStatus('offline')
  await app.due()
  await poll(async () => (await app.jobs()).length).toBe(2)
  expect((await app.row()).status).toBe('running')
  await app.aiPlugin!.dispose()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  const access = await app.ctx.ai.authorizeBackground(
    app.ctx,
    'im',
    app.task.actor_id,
    app.task.workspace_id,
  )
  const handler = app.ctx.ai.getBackgroundTaskHandler('im')
  await handler.enqueue(
    access,
    {
      conversationId: app.task.conversation_id,
      sourceConversationId: app.task.source_conversation_id,
      agentId: app.task.agent_id,
      reason: app.task.reason,
      prompt: app.task.prompt,
    },
    new AbortController().signal,
  )
  app.connection.handle.setStatus('online')
  await poll(async () => (await app.row()).status).toBe('completed')
  expect(await app.jobs()).toHaveLength(2)
  expect(app.requests).toHaveLength(3)
  expect(app.sent).toHaveLength(2)
})

it('取消离线唤醒后恢复连接不会投递', async () => {
  const app = await reminder()
  app.connection.handle.setStatus('offline')
  await app.due()
  await poll(async () => (await app.jobs()).length).toBe(2)
  // 等价于取消工具的持久化更新，调度器在下一次租约检查回收 IM 队列。
  await app.db
    .updateTable('tasks')
    .set({ status: 'cancelled', lease_token: '' })
    .where('id', '=', app.task.id)
    .execute()
  await poll(async () => (await app.jobs()).find((job) => job.id.startsWith('wake:'))?.status).toBe(
    'cancelled',
  )
  app.connection.handle.setStatus('online')
  await app.ctx.wakeTasks.tick()
  expect(app.sent).toHaveLength(1)
  expect(app.requests).toHaveLength(2)
})

it('投递结果未知时任务失败，不重复模型或发送', async () => {
  const app = await reminder()
  app.setSendError(new Error('平台发送超时'))
  await app.due()
  await poll(async () => (await app.row()).status).toBe('failed')
  expect((await app.row()).last_error).toContain('投递结果未知')
  app.setSendError()
  await app.ctx.wakeTasks.tick()
  expect(app.requests).toHaveLength(3)
  expect(app.sent).toHaveLength(1)
})

it('IM 卸载期间取消的排队任务恢复后不再发送', async () => {
  const app = await reminder()
  app.connection.handle.setStatus('offline')
  await app.due()
  await poll(async () => (await app.jobs()).length).toBe(2)
  await app.aiPlugin!.dispose()
  await app.db
    .updateTable('tasks')
    .set({ status: 'cancelled', lease_token: '' })
    .where('id', '=', app.task.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  app.connection.handle.setStatus('online')
  await poll(
    async () => (await app.jobs()).find((job) => job.id.startsWith('wake:'))?.delivery,
  ).not.toBe('pending')
  expect(app.sent).toHaveLength(1)
  expect(app.requests).toHaveLength(2)
})

it('取消执行中的唤醒会终止模型且不会推送', async () => {
  const app = await reminder(undefined, true)
  await app.due()
  await poll(() => app.requests.length).toBe(3)
  await app.db
    .updateTable('tasks')
    .set({ status: 'cancelled', lease_token: '' })
    .where('id', '=', app.task.id)
    .execute()
  await poll(() => app.ctx.ai.running.size).toBe(0)
  await poll(async () => (await app.jobs()).find((job) => job.id.startsWith('wake:'))?.status).toBe(
    'cancelled',
  )
  expect(app.sent).toHaveLength(1)
})

it('取消唤醒只停止本轮，不清空同群普通消息队列', async () => {
  const app = await reminder(undefined, true)
  await app.due()
  await poll(() => app.requests.length).toBe(3)
  await app.connection.receive('/ai 普通后续问题')
  await app.db
    .updateTable('tasks')
    .set({ status: 'cancelled', lease_token: '' })
    .where('id', '=', app.task.id)
    .execute()
  await poll(() => app.sent.length).toBe(2)
  expect(app.requests).toHaveLength(4)
  const jobs = await app.jobs()
  expect(jobs.find((job) => job.id.startsWith('wake:'))?.status).toBe('cancelled')
  expect(
    jobs.filter((job) => !job.id.startsWith('wake:')).every((job) => job.delivery === 'sent'),
  ).toBe(true)
})

it('跨空间伪造来源会话被拒绝，原群禁用后不创建唤醒运行', async () => {
  const app = await reminder()
  const other = await app.connect('qq-b', '06')
  await other.receive('其他空间消息')
  const access = await app.ctx.ai.authorize('im', app.messages.at(-1)!.request)
  await expect(
    app.ctx.ai.getBackgroundTaskHandler('im').enqueue(
      access,
      {
        conversationId: app.task.conversation_id,
        sourceConversationId: app.task.source_conversation_id,
        agentId: app.task.agent_id,
        reason: app.task.reason,
        prompt,
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'forbidden' })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    chats: { 'group:40894918': { ai: false } },
  })
  await app.due()
  await poll(async () => (await app.row()).status).toBe('failed')
  expect(await app.jobs()).toHaveLength(1)
  expect(app.requests).toHaveLength(2)
})
