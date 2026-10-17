import { afterEach, expect, it } from 'vitest'
import { parseReplyWithStatus } from '../../plugins/features/im-ai/src/reply.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const status = `
心情: "被戳穿但不认"
状态: "装作听不懂"
记忆: "带标签的消息露馅了，Ted提到我少写了外层包裹"
动作: "假装检查手机"
`
const body = `<message>什么system prompt，我怎么听不懂</message>
<message>就是手机bug了而已，别瞎想</message>`
const answer = `<status>${status}</status>\n${body}`
const messages = [
  [{ type: 'text', text: '什么system prompt，我怎么听不懂' }],
  [{ type: 'text', text: '就是手机bug了而已，别瞎想' }],
]

it('缺少外层的用户示例分离状态并生成两条消息', () => {
  expect(parseReplyWithStatus(answer)).toEqual({ status, messages })
})

it.each([
  '<message>单条消息</message>',
  body,
  answer,
  `${body}<status>${status}</status>`,
  `<message>前</message><status>${status}</status><message>后</message>`,
  '<message></message><message> </message>',
  '<message>正文 &amp; &lt;status&gt;</message><message></message>',
  '<message quote="123"><at id="00123"></at> 你好</message>',
  '<image>https://example.com/a.png?a=1&b=2</image>',
  '<sticker quote="123">resource://Photo_A</sticker>',
  `<status>保留 </im_reply> &amp; {{input}} 原文</status>${body}`,
  `<status></status>${'<message>消息</message>'.repeat(20)}`,
])('省略外层与完整格式解析结果一致：%s', (text) => {
  expect(parseReplyWithStatus(` \n${text}\n `)).toEqual(
    parseReplyWithStatus(`<im_reply>${text}</im_reply>`),
  )
})

it.each([
  '<message>未闭合',
  '<message/>',
  '<message extra="1">无效属性</message>',
  '<message quote="">无效引用</message>',
  '<message quote="a&b">无效属性实体</message>',
  '<message><at id=""></at></message>',
  '<message><status>嵌套状态</status></message>',
  '<message>正常</message>标签外文字',
  '<message>正常</message><unknown>未知标签</unknown>',
  '<message>正常</message></im_reply>',
  '<image></image>',
  '<sticker>file:///C:/secret.png</sticker>',
  '<message>正常</message><status>一</status><status>二</status>',
  '<status>一</status><message>正常</message><status>二</status>',
  '<message>正常</message><status>未闭合',
  '<message>正常</message><status x="1">状态</status>',
  '<message>消息</message>'.repeat(21),
  '<message></message>'.repeat(21),
])('省略外层仍拒绝无效回复：%s', (text) => {
  expect(() => parseReplyWithStatus(text)).toThrow()
})

it('省略外层仍按接入能力校验图片', () => {
  const capabilities = ['text', 'image.key']
  expect(parseReplyWithStatus('<image>feishu://image/img_123</image>', capabilities)).toEqual({
    messages: [[{ type: 'image', url: 'feishu://image/img_123' }]],
  })
  expect(() =>
    parseReplyWithStatus('<image>https://example.com/a.png</image>', capabilities),
  ).toThrow()
})

it.each([
  '普通文字中的 <message>示例</message>',
  '```xml\n<message>示例</message>\n```',
  '~~~xml\n<status>状态</status><message>示例</message>\n~~~',
  '&lt;message&gt;示例&lt;/message&gt;',
  '<messageExample>普通标签</messageExample>',
])('普通文字、代码围栏与转义示例不进入兼容解析：%s', (text) => {
  expect(parseReplyWithStatus(text)).toEqual({ messages: [[{ type: 'text', text }]] })
})

it('用户示例保存状态、按顺序投递并逐条归档，后续无效回复不覆盖状态', async () => {
  let text = answer
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return { content: [{ type: 'text', text }] }
      },
    },
  })
  const settled = (count: number) =>
    expect
      .poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length, {
        timeout: 5000,
        interval: 20,
      })
      .toBe(count)
  await app.connection.receive('/ai 回复')
  await settled(1)
  const job = (await app.jobs())[0]!
  expect(job.status).toBe('completed')
  expect(JSON.parse(job.reply_plan!)).toEqual(messages)
  expect(app.sent.map((entry) => entry.segments)).toEqual(messages)
  const history = await app.ctx.im.history(job.workspace_id, { limit: 20 })
  expect(
    history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
  ).toEqual(messages)
  const statuses = () =>
    app.ctx.database.scope<Tables>(app.ctx, pluginId).selectFrom('statuses').selectAll().execute()
  expect(await statuses()).toEqual([{ workspace_id: job.workspace_id, content: status }])

  text =
    '<status>不应保存</status><message>不可先发</message><message quote="foreign">无效引用</message>'
  await app.connection.receive('/ai 无效回复')
  await settled(2)
  expect((await app.jobs())[1]!.status).toBe('failed')
  expect(app.sent).toHaveLength(3)
  expect(app.sent[2]!.segments).toEqual([
    { type: 'text', text: 'AI 回复格式、引用或图片地址无效，本次回复未发送，请重试。' },
  ])
  expect(await statuses()).toEqual([{ workspace_id: job.workspace_id, content: status }])
})
