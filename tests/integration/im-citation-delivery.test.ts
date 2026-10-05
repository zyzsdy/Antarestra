import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { MessageSegment } from '@antarestra/im'
import * as OneBot from '../../plugins/adapters/im-onebot/src/index.js'
import { cleanup, setup } from './im-features-fixture.js'

const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await cleanup()
})
const citation = '([来源](https://example.com/?a=1&b=2))'
const answer = `<im_reply><message>推荐《摇曳百合》。 ${citation}</message></im_reply>`
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })

async function connect(filterCitationLinks?: boolean) {
  const app = await setup({
    ai: true,
    driver: { id: 'driver', generate: async () => ({ content: [{ type: 'text', text: answer }] }) },
  })
  await app.ctx.plugin(OneBot, {
    id: 'filtered',
    selfId: '06',
    token: 'local-test-token',
    ...(filterCitationLinks !== undefined ? { filterCitationLinks } : {}),
  })
  await app.ctx.im.setPolicy('filtered', app.defaultPolicy)
  const socket = new WebSocket(
    `ws://127.0.0.1:${app.ctx.server.address!.port}/im/onebot/filtered`,
    {
      headers: {
        Authorization: 'Bearer local-test-token',
        'X-Self-ID': '06',
        'X-Client-Role': 'Universal',
      },
    },
  )
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const sent: unknown[] = []
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString()) as {
      action: string
      echo: string
      params: Record<string, unknown>
    }
    let data: Record<string, unknown> = { user_id: '79338528', role: 'member' }
    if (request.action === 'send_group_msg' || request.action === 'send_private_msg') {
      sent.push(request.params.message)
      data = { message_id: String(100 + sent.length) }
    }
    socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }))
  })
  const receive = async (text: string) => {
    socket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        self_id: '06',
        user_id: '79338528',
        group_id: '40894918',
        message_id: '1',
        sender: { nickname: '测试用户', role: 'member' },
        message: [{ type: 'text', data: { text } }],
      }),
    )
    await poll(() => app.messages.length).toBe(1)
    return app.messages[0]!
  }
  return { ...app, sentRpc: sent, receive }
}

it.each([undefined, false, true])(
  'OneBot 过滤开关 %s 经 AI 回复和真实本地 WebSocket 生效',
  async (enabled) => {
    const app = await connect(enabled)
    const context = await app.receive('/ai 推荐日常动画')
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    const expected = enabled ? '推荐《摇曳百合》。' : `推荐《摇曳百合》。 ${citation}`
    expect(app.sentRpc).toEqual([[{ type: 'text', data: { text: expected } }]])
    const job = (await app.jobs())[0]!
    expect(job.status).toBe('completed')
    expect(job.answer).toBe(answer)
    expect(job.reply_plan).toContain('https://example.com/')
    const history = await app.ctx.im.history(context.workspaceId, { limit: 20 })
    expect(
      history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
    ).toEqual([[{ type: 'text', text: expected }]])
    // 发送时的过滤不改写模型原始回答，也不影响另一个接入实例。
    await app.connection.receive('/ai 推荐日常动画')
    await poll(
      async () => (await app.jobs()).filter((entry) => entry.delivery === 'sent').length,
    ).toBe(2)
    expect(app.sent[0]!.segments).toEqual([
      { type: 'text', text: `推荐《摇曳百合》。 ${citation}` },
    ])
  },
)

it('纯引用过滤为空时不调用平台，保持幂等且仍拒绝跨空间引用', async () => {
  const app = await connect(true)
  const context = await app.receive('普通发言')
  const target = {
    connectionId: 'filtered',
    workspaceId: context.workspaceId,
    chat: context.message.chat,
  }
  const beforeSend = vi.fn()
  const segments: MessageSegment[] = [
    { type: 'reply', messageId: '1' },
    { type: 'text', text: citation },
  ]
  expect(await app.ctx.im.send(target, segments, { idempotencyKey: 'empty', beforeSend })).toEqual(
    {},
  )
  // 恢复同键时即使正文不同，也不得重新发送已完成的消息。
  expect(
    await app.ctx.im.send(target, [{ type: 'text', text: '不能补发' }], {
      idempotencyKey: 'empty',
    }),
  ).toEqual({})
  expect(beforeSend).toHaveBeenCalledTimes(1)
  expect(app.sentRpc).toEqual([])
  await expect(
    app.ctx.im.send(target, segments, {
      beforeSend: () => {
        throw new Error('业务权限已撤销')
      },
    }),
  ).rejects.toThrow('业务权限已撤销')
  const history = await app.ctx.im.history(context.workspaceId, { limit: 20 })
  expect(history.filter((entry) => entry.message.sender.bot)).toEqual([])
  await expect(
    app.ctx.im.send(target, [
      { type: 'reply', messageId: 'foreign' },
      { type: 'text', text: citation },
    ]),
  ).rejects.toMatchObject({ code: 'foreign_message' })
  await expect(app.ctx.im.send({ ...target, workspaceId: 'foreign' }, segments)).rejects.toThrow(
    '不属于',
  )
})

it('过滤仅转换文本，保留图片地址、提及与原生引用，归档和重试保持一致', async () => {
  const app = await connect(true)
  const context = await app.receive('普通发言')
  const target = {
    connectionId: 'filtered',
    workspaceId: context.workspaceId,
    chat: context.message.chat,
  }
  const segments: MessageSegment[] = [
    { type: 'reply', messageId: '1' },
    { type: 'text', text: citation },
    { type: 'mention', userId: '00123' },
    { type: 'image', url: 'https://example.com/a.png?a=1&b=2' },
  ]
  await app.ctx.im.send(target, segments, { idempotencyKey: 'mixed' })
  await app.ctx.im.send(target, segments, { idempotencyKey: 'mixed' })
  expect(app.sentRpc).toEqual([
    [
      { type: 'reply', data: { id: '1' } },
      { type: 'at', data: { qq: '00123' } },
      { type: 'image', data: { file: 'https://example.com/a.png?a=1&b=2' } },
    ],
  ])
  const history = await app.ctx.im.history(context.workspaceId, { limit: 20 })
  expect(
    history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
  ).toEqual([[segments[0], segments[2], segments[3]]])
  expect(segments[1]).toEqual({ type: 'text', text: citation })
})
