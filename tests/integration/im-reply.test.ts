import { afterEach, expect, it, vi } from 'vitest'
import imAi from '@antarestra/plugin-im-ai'
import type { ModelDriver } from '@antarestra/ai'
import { parseReply, replyFormatGuide } from '../../plugins/features/im-ai/src/reply.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'
import { encodeMessage as encodeOneBot } from '../../plugins/adapters/im-onebot/src/message.js'
import { encodeMessage as encodeFeishu } from '../../plugins/adapters/im-feishu/src/message.js'

afterEach(cleanup)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })
const driver = (text: string): ModelDriver => ({
  id: 'driver',
  async generate() {
    return { content: [{ type: 'text', text }] }
  },
})
const webSearchAnswer = `我会先推《摇曳百合》，日常搞笑，很适合放松看 ([yuruyuri.com](https://yuruyuri.com/3hai/story/introduction.php?utm_source=openai))
再来《黄金拼图》，偏温馨的校园日常 ([kinmosa.com](https://kinmosa.com/?utm_source=openai))
想沿着《摇曳百合》接着看，也可以补《大室家》 ([prtimes.jp](https://prtimes.jp/a/?c=2734&f=d2734-1914-2cf413d19e804c57ec7ca4023158b213.pdf&r=1914&utm_source=openai))`

it.each(['原始链接', '已转义链接'])('网页搜索回复保留链接并完成投递和归档：%s', async (format) => {
  const body = format === '原始链接' ? webSearchAnswer : webSearchAnswer.replaceAll('&', '&amp;')
  const answer = `<im_reply><message>${body}</message></im_reply>`
  const segments = [{ type: 'text' as const, text: webSearchAnswer }]
  expect(parseReply(answer)).toEqual([segments])
  const app = await setup({ ai: true, driver: driver(answer) })
  await app.connection.receive('/ai 推荐日常动画')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  const job = (await app.jobs())[0]!
  expect(job.status).toBe('completed')
  expect(JSON.parse(job.reply_plan!)).toEqual([segments])
  expect(app.sent.map((entry) => entry.segments)).toEqual([segments])
  const history = await app.ctx.im.history(job.workspace_id, { limit: 20 })
  expect(
    history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
  ).toEqual([segments])
  expect(encodeOneBot(app.sent[0]!.segments)).toEqual([
    { type: 'text', data: { text: webSearchAnswer } },
  ])
  expect(encodeFeishu(app.sent[0]!.segments)).toEqual({
    msg_type: 'text',
    content: JSON.stringify({ text: webSearchAnswer.replaceAll('&', '&amp;') }),
  })
})

it('正文原始符号和未知实体保留为文本，已知实体只解码一次且不生成标签', () => {
  expect(
    parseReply(
      `<im_reply><message>A & B "双引号" '单引号' &unknown; &#38; &amp;lt; <at id="00123"></at> &lt;at id=&quot;456&quot;&gt;&lt;/at&gt; &</message></im_reply>`,
    ),
  ).toEqual([
    [
      { type: 'text', text: `A & B "双引号" '单引号' &unknown; &#38; &lt; ` },
      { type: 'mention', userId: '00123' },
      { type: 'text', text: ' <at id="456"></at> &' },
    ],
  ])
})

it.each(['image', 'sticker'])('%s 地址支持原始与转义的参数分隔符混用', (tag) => {
  expect(
    parseReply(
      `<im_reply><${tag}>https://example.com/a.png?a=1&b=2&amp;c=%26&amp;amp;d=4&unknown;</${tag}></im_reply>`,
    ),
  ).toEqual([[{ type: 'image', url: 'https://example.com/a.png?a=1&b=2&c=%26&amp;d=4&unknown;' }]])
})

it('按顺序解析文本、图片、表情包和引用，实体仅解码一次', () => {
  expect(
    parseReply(`<im_reply>
<message>第一条 &amp; &lt;message&gt;\n第二行</message>
<image>https://example.com/a.png?a=1&amp;b=2</image>
<sticker quote="123">https://example.com/a.gif</sticker>
<message quote="456">&amp;lt; &quot; &apos;</message>
</im_reply>`),
  ).toEqual([
    [{ type: 'text', text: '第一条 & <message>\n第二行' }],
    [{ type: 'image', url: 'https://example.com/a.png?a=1&b=2' }],
    [
      { type: 'reply', messageId: '123' },
      { type: 'image', url: 'https://example.com/a.gif' },
    ],
    [
      { type: 'reply', messageId: '456' },
      { type: 'text', text: '&lt; " \'' },
    ],
  ])
  for (const text of [
    '普通文本',
    '示例 <message>你好</message>',
    '```xml\n<im_reply>示例</im_reply>\n```',
  ])
    expect(parseReply(text)).toEqual([[{ type: 'text', text }]])
})

it('引用消息中按顺序混排文本和多个提及，保留用户 ID 与内部空白', () => {
  expect(
    parseReply(
      '<im_reply><message quote="123">  你好 &amp; <at id="00123"></at>\n和 <at id="ou_friend"></at><at id="00456"></at> 一起聊聊  </message></im_reply>',
    ),
  ).toEqual([
    [
      { type: 'reply', messageId: '123' },
      { type: 'text', text: '你好 & ' },
      { type: 'mention', userId: '00123' },
      { type: 'text', text: '\n和 ' },
      { type: 'mention', userId: 'ou_friend' },
      { type: 'mention', userId: '00456' },
      { type: 'text', text: ' 一起聊聊' },
    ],
  ])
  expect(parseReply('<im_reply><message><at id="00123"></at></message></im_reply>')).toEqual([
    [{ type: 'mention', userId: '00123' }],
  ])
  expect(replyFormatGuide()).toContain('<at id="用户ID"></at>')
})

it('转义的 at 保持为文本，属性实体仅解码一次，普通回复不提取标签', () => {
  expect(
    parseReply(
      '<im_reply><message>&lt;at id=&quot;123&quot;&gt;&lt;/at&gt;<at id="ou_&amp;quot;"></at></message></im_reply>',
    ),
  ).toEqual([
    [
      { type: 'text', text: '<at id="123"></at>' },
      { type: 'mention', userId: 'ou_&quot;' },
    ],
  ])
  const plain = '示例 <at id="123"></at>'
  expect(parseReply(plain)).toEqual([[{ type: 'text', text: plain }]])
})

it.each([
  '<at></at>',
  '<at id=""></at>',
  '<at id=" "></at>',
  '<at id="123 456"></at>',
  '<at id="123\u0000"></at>',
  `<at id="${'x'.repeat(201)}"></at>`,
  '<at id="123" id="456"></at>',
  '<at id="123" name="某人"></at>',
  '<at id="123">某人</at>',
  '<at id="123"><at id="456"></at></at>',
  '<at id="123"/>',
  '<at id="123">',
  '<at id="&unknown;"></at>',
  '<at id="a&b"></at>',
])('拒绝无效的提及标签：%s', (at) => {
  expect(() => parseReply(`<im_reply><message>你好${at}</message></im_reply>`)).toThrow()
})

it.each([
  '<im_reply>',
  '<im_reply></im_reply>',
  '<im_reply x="1"><message>好</message></im_reply>',
  '<im_reply><message>好</message>额外文字</im_reply>',
  '<im_reply><message>好</message></im_reply>额外文字',
  '<im_reply><image> </image></im_reply>',
  '<im_reply><sticker></sticker></im_reply>',
  '<im_reply><message quote=""></message></im_reply>',
  '<im_reply><message quote="">好</message></im_reply>',
  '<im_reply><message quote="1" quote="2">好</message></im_reply>',
  '<im_reply><message><image>https://example.com/a.png</image></message></im_reply>',
  '<im_reply><message quote="&unknown;">无效属性实体</message></im_reply>',
  '<im_reply><message quote="a&b">未转义属性</message></im_reply>',
  '<im_reply><image>file:///C:/secret.png</image></im_reply>',
  '<im_reply><sticker>base64://xxx</sticker></im_reply>',
  '<im_reply><image>https://user:pass@example.com/a.png</image></im_reply>',
  '<im_reply><unknown>文本</unknown></im_reply>',
  '<im_reply><at id="123"></at></im_reply>',
  '<im_reply><image><at id="123"></at></image></im_reply>',
  '<im_reply><sticker><at id="123"></at></sticker></im_reply>',
  `<im_reply>${'<message>文本</message>'.repeat(21)}</im_reply>`,
  `<im_reply>${'<message></message>'.repeat(21)}</im_reply>`,
])('拒绝无效的整份回复：%s', (text) => {
  expect(() => parseReply(text)).toThrow()
})

it.each([
  '',
  ' \n ',
  '<message></message>',
  ' <message> \n </message> ',
  '<im_reply><message></message></im_reply>',
  '<im_reply><message> \n </message><message></message></im_reply>',
])('空回复解析为无需发送的计划：%s', (text) => {
  expect(parseReply(text)).toEqual([])
})

it('忽略空白文本标签，保留非空文本和图片顺序，仍校验完整格式', () => {
  expect(
    parseReply(
      '<im_reply><message></message><message>正文</message><message> </message><image>https://example.com/a.png</image></im_reply>',
    ),
  ).toEqual([
    [{ type: 'text', text: '正文' }],
    [{ type: 'image', url: 'https://example.com/a.png' }],
  ])
  expect(() => parseReply('<im_reply><message></message><message>未闭合</im_reply>')).toThrow()
  expect(replyFormatGuide()).toContain('<message></message>')
  expect(replyFormatGuide()).toContain('IM 侧不会发送任何消息')
})

it.each(['<message></message>', '<im_reply><message> \n </message></im_reply>', ''])(
  '自主空回复正常完成，不发送消息或错误提示，恢复空计划也不重跑模型：%s',
  async (text) => {
    const generate = vi.fn(driver(text).generate)
    const app = await setup({ ai: true, driver: { id: 'driver', generate } })
    await app.connection.receive('/ai 看一下聊天')
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    const job = (await app.jobs())[0]!
    expect(job).toMatchObject({
      status: 'completed',
      answer: text.trim(),
      reply_plan: '[]',
      attempts: 0,
    })
    expect(app.sent).toHaveLength(0)
    expect(
      (await app.ctx.im.history(job.workspace_id, { limit: 20 })).filter(
        (entry) => entry.message.sender.bot,
      ),
    ).toHaveLength(0)

    await app.aiPlugin!.dispose()
    await app.ctx.database
      .scope<Tables>(app.ctx, pluginId)
      .updateTable('jobs')
      .set({ delivery: 'pending' })
      .where('id', '=', job.id)
      .execute()
    await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(app.sent).toHaveLength(0)
    expect((await app.jobs())[0]?.attempts).toBe(0)
  },
)

it('飞书图片使用平台资源键，指引明确平台差异', () => {
  const capabilities = ['text', 'reply', 'image.key']
  expect(
    parseReply('<im_reply><image>feishu://image/img_123</image></im_reply>', capabilities),
  ).toEqual([[{ type: 'image', url: 'feishu://image/img_123' }]])
  expect(() =>
    parseReply('<im_reply><image>https://example.com/a.png</image></im_reply>', capabilities),
  ).toThrow()
  expect(() => parseReply('<im_reply><image>feishu://image/img_123</image></im_reply>')).toThrow()
  expect(replyFormatGuide(capabilities)).toContain('不支持直接发送 HTTP 图片链接')
})

it('一次运行按顺序发送独立消息，引用当前群友发言并逐条归档', async () => {
  const app = await setup({
    ai: true,
    driver: driver(`<im_reply>
<message>第一条</message><image>https://example.com/a.png</image>
<message quote="friend">同意你的观点</message><sticker>https://example.com/b.gif</sticker>
</im_reply>`),
  })
  await app.connection.receive('群友发言', { id: 'friend' })
  await app.connection.receive('/ai 回答')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.sent.map((entry) => entry.segments)).toEqual([
    [{ type: 'text', text: '第一条' }],
    [{ type: 'image', url: 'https://example.com/a.png' }],
    [
      { type: 'reply', messageId: 'friend' },
      { type: 'text', text: '同意你的观点' },
    ],
    [{ type: 'image', url: 'https://example.com/b.gif' }],
  ])
  const job = (await app.jobs())[0]!
  const history = await app.ctx.im.history(job.workspace_id, { limit: 20 })
  expect(history.filter((entry) => entry.message.sender.bot)).toHaveLength(4)
  expect(JSON.parse(job.reply_plan!)).toHaveLength(4)
})

it.each(['00123', 'ou_friend'])(
  'AI 提及 %s 经发送计划、投递和归档保留原生消息段',
  async (userId) => {
    const app = await setup({
      ai: true,
      driver: driver(
        `<im_reply><message quote="friend"><at id="${userId}"></at> 你好</message><message><at id="${userId}"></at></message></im_reply>`,
      ),
    })
    await app.connection.receive('群友发言', { id: 'friend', sender: { id: userId } })
    await app.connection.receive('/ai 回复')
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    const expected = [
      [
        { type: 'reply', messageId: 'friend' },
        { type: 'mention', userId },
        { type: 'text', text: ' 你好' },
      ],
      [{ type: 'mention', userId }],
    ]
    expect(app.sent.map((entry) => entry.segments)).toEqual(expected)
    const job = (await app.jobs())[0]!
    expect(job.status).toBe('completed')
    expect(JSON.parse(job.reply_plan!)).toEqual(expected)
    const history = await app.ctx.im.history(job.workspace_id, { limit: 20 })
    expect(
      history.filter((entry) => entry.message.sender.bot).map((entry) => entry.message.segments),
    ).toEqual(expected)
    const segments = app.sent[0]!.segments
    if (userId === '00123') {
      expect(encodeOneBot(segments)).toEqual([
        { type: 'reply', data: { id: 'friend' } },
        { type: 'at', data: { qq: userId } },
        { type: 'text', data: { text: ' 你好' } },
      ])
    } else {
      expect(encodeFeishu(segments)).toEqual({
        replyId: 'friend',
        msg_type: 'text',
        content: JSON.stringify({ text: `<at user_id="${userId}"></at> 你好` }),
      })
    }
  },
)

it.each([
  '<message>未闭合',
  '<message quote="foreign">跨群引用</message>',
  '<message><at id="">无效提及</at></message>',
])('整份预检失败不先发第一条：%s', async (suffix) => {
  const app = await setup({
    ai: true,
    driver: driver(`<im_reply><message>不可先发</message>${suffix}</im_reply>`),
  })
  const other = await app.connect('qq-b', '06')
  await other.receive('另一个接入的消息', { id: 'foreign' })
  await app.connection.receive('/ai 回复')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect((await app.jobs())[0]?.status).toBe('failed')
  expect(app.sent).toHaveLength(1)
  expect(app.sent[0]?.segments).toEqual([
    { type: 'text', text: 'AI 回复格式、引用或图片地址无效，本次回复未发送，请重试。' },
  ])
})

it.each([
  { append: false, system: '系统', expected: 'none' },
  { append: true, system: '系统', expected: 'tail' },
  { append: false, system: '前文{{ im_reply_format }}后文', expected: 'inline' },
  { append: true, system: '前文{{im_reply_format}}后文', expected: 'inline' },
] as const)('自动追加与显式模板位置：$append / $expected', async ({ append, system, expected }) => {
  let prompt = ''
  const app = await setup({
    ai: true,
    systemTemplate: system,
    driver: {
      id: 'driver',
      async generate(request) {
        prompt = request.systemPrompt
        return { content: [{ type: 'text', text: '回答' }] }
      },
    },
  })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: { appendReplyFormat: append },
  })
  await app.connection.receive('/ai 问题')
  await poll(() => app.sent.length).toBe(1)
  if (expected === 'none') expect(prompt).toBe('系统')
  else {
    expect(prompt.split('回复格式：')).toHaveLength(2)
    expect(prompt).toBe(
      expected === 'tail' ? `系统\n\n${replyFormatGuide([])}` : `前文${replyFormatGuide([])}后文`,
    )
  }
  expect(app.ctx.ai.listTemplateVariables()).toContainEqual(
    expect.objectContaining({ id: 'im_reply_format' }),
  )
  await app.aiPlugin!.dispose()
  expect(app.ctx.ai.listTemplateVariables().some((item) => item.id === 'im_reply_format')).toBe(
    false,
  )
})

it('回复格式开关按接入、聊天类型和单独聊天逐级覆盖，拒绝非布尔值', async () => {
  const app = await setup()
  await app.ctx.im.setPolicy('qq-a', {
    defaults: { appendReplyFormat: true },
    group: { mode: 'blacklist', ids: [], defaults: { appendReplyFormat: false } },
    private: { mode: 'blacklist', ids: [] },
    chats: { 'group:40894918': { appendReplyFormat: true } },
  })
  expect(
    app.ctx.im.getChatPolicy('qq-a', { type: 'group', id: '40894918' }).appendReplyFormat,
  ).toBe(true)
  expect(app.ctx.im.getChatPolicy('qq-a', { type: 'group', id: 'other' }).appendReplyFormat).toBe(
    false,
  )
  expect(app.ctx.im.getChatPolicy('qq-a', { type: 'private', id: 'user' }).appendReplyFormat).toBe(
    true,
  )
  await expect(
    app.ctx.im.setPolicy('qq-a', JSON.parse('{"defaults":{"appendReplyFormat":"true"}}')),
  ).rejects.toThrow()
})

it('非 IM 任务不注入回复格式，群友原文中的变量也不会递归展开', async () => {
  const prompts: string[] = []
  const inputs: string[] = []
  const app = await setup({
    ai: true,
    systemTemplate: '前{{im_reply_format}}后',
    driver: {
      id: 'driver',
      async generate(request) {
        prompts.push(request.systemPrompt)
        inputs.push(JSON.stringify(request.messages))
        return { content: [{ type: 'text', text: '回答' }] }
      },
    },
  })
  await app.connection.receive('/ai {{im_reply_format}}')
  await poll(() => app.sent.length).toBe(1)
  expect(inputs[0]).toContain('{{im_reply_format}}')
  expect(prompts[0]).toBe(`前${replyFormatGuide([])}后`)
  const access = await app.ctx.ai.authorize('im', app.messages[0]!.request)
  const conversation = await app.ctx.ai.createConversation(access, 'assistant')
  const run = await app.ctx.ai.start(access, conversation.id, {
    operation: 'send',
    expectedRevision: conversation.revision,
    expectedNodeId: conversation.selectedNodeId,
    idempotencyKey: 'without-im-job',
    input: { text: '普通 AI 运行' },
  })
  await poll(async () => (await app.ctx.ai.getRun(access, run.id)).status).toBe('completed')
  expect(prompts[1]).toBe('前后')
  expect(app.sent).toHaveLength(1)
})

it('中途明确失败后恢复已保存的发送计划，跳过已送达消息且不重新调用模型', async () => {
  const generate = vi.fn(
    driver('<im_reply><message>一</message><message>二</message><message>三</message></im_reply>')
      .generate,
  )
  const app = await setup({ ai: true, deliveryAttempts: 1, driver: { id: 'driver', generate } })
  const send = app.ctx.im.send.bind(app.ctx.im)
  let calls = 0
  const spy = vi.spyOn(app.ctx.im, 'send').mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error('发送前连接暂不可用')
    return send(...args)
  })
  await app.connection.receive('/ai 回复')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('failed')
  expect(app.sent.map((entry) => entry.segments)).toEqual([[{ type: 'text', text: '一' }]])
  const job = (await app.jobs())[0]!
  await app.aiPlugin!.dispose()
  spy.mockRestore()
  await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .updateTable('jobs')
    .set({ delivery: 'pending', attempts: 0 })
    .where('id', '=', job.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(generate).toHaveBeenCalledTimes(1)
  expect(app.sent.map((entry) => entry.segments)).toEqual(
    ['一', '二', '三'].map((text) => [{ type: 'text', text }]),
  )
})

it('第二条投递结果未知时保留首条并停止后续发送', async () => {
  const app = await setup({
    ai: true,
    driver: driver(
      '<im_reply><message>一</message><message>二</message><message>三</message></im_reply>',
    ),
  })
  const send = app.ctx.im.send.bind(app.ctx.im)
  vi.spyOn(app.ctx.im, 'send').mockImplementation(async (...args) => {
    const result = await send(...args)
    app.setSendError(new Error('平台超时'))
    return result
  })
  await app.connection.receive('/ai 回复')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('unknown')
  expect(app.sent).toHaveLength(1)
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '一' }])
  expect((await app.jobs())[0]?.attempts).toBe(1)
})
