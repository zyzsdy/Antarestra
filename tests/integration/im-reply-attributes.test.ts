import { afterEach, expect, it } from 'vitest'
import { parseReplyWithStatus } from '../../plugins/features/im-ai/src/reply.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)

it('所有受支持标签忽略未知属性，引用和提及不受属性顺序影响', () => {
  expect(
    parseReplyWithStatus(
      `<im_reply version="2">
<status format='text'>保留 &amp; 原文</status>
<message cut="false" quote = '123' extra="1">你好<at name="某人" id=00123 extra></at></message>
<image alt="图片" quote="123" extra=false>https://example.com/a.png</image>
<sticker extra="1" quote="456">resource://Photo_A</sticker>
<file name="文件.txt">https://example.com/a.txt</file>
</im_reply>`,
      ['image', 'file'],
    ),
  ).toEqual({
    status: '保留 &amp; 原文',
    messages: [
      [
        { type: 'reply', messageId: '123' },
        { type: 'text', text: '你好' },
        { type: 'mention', userId: '00123' },
      ],
      [
        { type: 'reply', messageId: '123' },
        { type: 'image', url: 'https://example.com/a.png' },
      ],
      [
        { type: 'reply', messageId: '456' },
        { type: 'image', url: 'resource://Photo_A', sticker: true },
      ],
      [{ type: 'file', url: 'https://example.com/a.txt' }],
    ],
  })
})

it('未知属性中的标签、引号、实体与大于号不泄露到正文或变成真实属性', () => {
  expect(
    parseReplyWithStatus(`<im_reply note="</im_reply>">
<status note="</status>">原始状态</status>
<message note='quote="foreign" > <at id="999"></at>' extra="a&b&unknown;" extra="重复未知属性">正文<at note='id="999" > </message>' id="00123"></at></message>
</im_reply>`),
  ).toEqual({
    status: '原始状态',
    messages: [
      [
        { type: 'text', text: '正文' },
        { type: 'mention', userId: '00123' },
      ],
    ],
  })
})

it.each([
  '<message cut="false" quote="1" extra="x" quote="2">正文</message>',
  '<message cut="false" quote="">正文</message>',
  '<message cut="false" quote>正文</message>',
  '<message cut="false" quote="a&b">正文</message>',
  '<message><at name="某人"></at></message>',
  '<message><at id="1" name="某人" id="2"></at></message>',
  '<message><at id="" name="某人"></at></message>',
  '<file name="文件" quote="1">https://example.com/a.txt</file>',
  '<message cut="未闭合>正文</message>',
  '<message cut=>正文</message>',
  '<message cut="false"extra="1">正文</message>',
  '<message cut="false"><unknown>正文</unknown></message>',
  '<status extra="1">一</status><status extra="2">二</status>',
])('兼容未知属性后仍拒绝无效格式与已定义属性：%s', (text) => {
  expect(() => parseReplyWithStatus(`<im_reply>${text}</im_reply>`)).toThrow()
})

it('带 cut 属性的最终回复完成状态保存、投递和归档', async () => {
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return {
          content: [
            {
              type: 'text',
              text: '<im_reply><status>正在聊天</status><message cut="false">回复正文</message></im_reply>',
            },
          ],
        }
      },
    },
  })
  await app.connection.receive('/ai 回复')
  await expect
    .poll(async () => (await app.jobs())[0]?.delivery, { timeout: 5000, interval: 20 })
    .toBe('sent')
  const job = (await app.jobs())[0]!
  const messages = [[{ type: 'text', text: '回复正文' }]]
  expect(job.status).toBe('completed')
  expect(JSON.parse(job.reply_plan!)).toEqual(messages)
  expect(app.sent.map((entry) => entry.segments)).toEqual(messages)
  const history = await app.ctx.im.history(job.workspace_id, { limit: 20 })
  expect(
    history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
  ).toEqual(messages)
  expect(
    await app.ctx.database
      .scope<Tables>(app.ctx, pluginId)
      .selectFrom('statuses')
      .selectAll()
      .execute(),
  ).toEqual([{ workspace_id: job.workspace_id, content: '正在聊天' }])
})
