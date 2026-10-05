import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import imAi from '@antarestra/plugin-im-ai'
import type { ModelDriver } from '@antarestra/ai'
import { parseReplyWithStatus, replyFormatGuide } from '../../plugins/features/im-ai/src/reply.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

const directories: string[] = []
afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })
const content = '\n心情: "开心"\n状态: "正在闲聊"\n记忆: ""\n动作: "拿起手机聊天"\n'
const block = (value = content) => `<status>${value}</status>`
const statusDb = (app: Awaited<ReturnType<typeof setup>>) =>
  app.ctx.database.scope<Tables>(app.ctx, pluginId)
const statuses = (app: Awaited<ReturnType<typeof setup>>) =>
  statusDb(app).selectFrom('statuses').selectAll().execute()
const settled = (app: Awaited<ReturnType<typeof setup>>, count: number) =>
  poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(count)

it.each([
  block(),
  `<im_reply>${block()}</im_reply>`,
  `${block()}<message></message>`,
  `<message></message>${block()}`,
])('只有状态时不生成聊天消息：%s', (text) => {
  expect(parseReplyWithStatus(text)).toEqual({ messages: [], status: content })
})

it.each([
  `${block()}你好`,
  `你好\n${block()}`,
  `<im_reply>${block()}<message>你好</message></im_reply>`,
  `<im_reply><message>你好</message>${block()}</im_reply>`,
  `${block()}<im_reply><message>你好</message></im_reply>`,
  `<im_reply><message>你好</message></im_reply>${block()}`,
])('从回复中分离状态原文：%s', (text) => {
  expect(parseReplyWithStatus(text)).toEqual({
    messages: [[{ type: 'text', text: '你好' }]],
    status: content,
  })
})

it('状态不限制字段、格式或标签，不解码实体、不裁剪空白，也不占消息条数', () => {
  const raw = ' \r\n随便记一点\n<随想>1 < 2 & "开心"</随想>\n&lt; {{input}} </im_reply>\n '
  expect(parseReplyWithStatus(`<im_reply>${block(raw)}</im_reply>`)).toEqual({
    messages: [],
    status: raw,
  })
  expect(
    parseReplyWithStatus(`<im_reply>${'<message>消息</message>'.repeat(20)}${block()}</im_reply>`)
      .messages,
  ).toHaveLength(20)
  expect(parseReplyWithStatus(block(''))).toEqual({ messages: [], status: '' })
  expect(parseReplyWithStatus('你好')).not.toHaveProperty('status')
  expect(replyFormatGuide()).toContain('{{ im_status }}')
})

it.each([
  '<status>未闭合',
  '正文\n<status>未闭合',
  '<status x="1">状态</status>',
  '</status>',
  `${block()}${block()}`,
  `<im_reply>${block()}${block()}</im_reply>`,
  `<im_reply><message>${block()}</message></im_reply>`,
  `<im_reply>${block()}</im_reply>${block()}`,
])('拒绝无效状态外层或重复状态块：%s', (text) => {
  expect(() => parseReplyWithStatus(text)).toThrow()
})

it('围栏代码与转义示例保持普通内容', () => {
  const text = `\`\`\`xml\n${block()}\n\`\`\``
  expect(parseReplyWithStatus(text)).toEqual({ messages: [[{ type: 'text', text }]] })
  expect(
    parseReplyWithStatus(
      '<im_reply><message>&lt;status&gt;示例&lt;/status&gt;</message></im_reply>',
    ),
  ).toEqual({ messages: [[{ type: 'text', text: '<status>示例</status>' }]] })
})

it('状态按 workspace 保存，同群成员共享，不同群、私聊用户和接入独立', async () => {
  const prompts: string[] = []
  let answer = `<im_reply><message>收到</message>${block()}</im_reply>`
  const app = await setup({
    ai: true,
    systemTemplate: '当前状态：{{ im_status }}',
    driver: {
      id: 'driver',
      async generate(request) {
        prompts.push(request.systemPrompt)
        return { content: [{ type: 'text', text: answer }] }
      },
    },
  })
  const connection = await app.connect('status-chats', '07', {
    group: {
      mode: 'whitelist',
      ids: ['40894918', 'other'],
      defaults: { ai: true, agentId: 'assistant' },
    },
    private: {
      mode: 'whitelist',
      ids: ['user-a', 'user-b'],
      defaults: { ai: true, agentId: 'assistant' },
    },
  })
  await connection.receive('/ai 第一轮')
  await settled(app, 1)
  expect(prompts[0]).toBe('当前状态：')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '收到' }])
  answer = '这轮不更新状态'
  await connection.receive('/ai 同群第二位成员', { sender: { id: 'another-member' } })
  await settled(app, 2)
  expect(prompts[1]).toBe(`当前状态：${content}`)
  expect(await statuses(app)).toEqual([{ workspace_id: app.messages[0]!.workspaceId, content }])
  for (const [index, chat] of [
    { type: 'group' as const, id: 'other' },
    { type: 'private' as const, id: 'user-a' },
    { type: 'private' as const, id: 'user-b' },
  ].entries()) {
    answer = block(`独立状态 ${chat.id}`)
    expect(app.ctx.im.getChatPolicy('status-chats', chat).enabled).toBe(true)
    await connection.receive('/ai 独立聊天', { chat, sender: { id: chat.id } })
    await settled(app, index + 3)
    expect(prompts[index + 2]).toBe('当前状态：')
  }
  answer = block('另一个接入的状态')
  await (await app.connect('qq-b', '06')).receive('/ai 相同群号不同接入')
  await settled(app, 6)
  expect(prompts[5]).toBe('当前状态：')
  const rows = await statuses(app)
  expect(rows).toHaveLength(5)
  expect(new Set(rows.map((row) => row.workspace_id)).size).toBe(5)
  expect(rows.find((row) => row.workspace_id === app.messages[0]!.workspaceId)?.content).toBe(
    content,
  )
})

it('排队请求在执行时读取上一轮状态，系统、用户和接入模板都原样插入且不递归展开', async () => {
  const raw = '\n自由文本 <随想> &lt; {{ input }} {{im_status}} {{last_message}}\n'
  const prompts: { system: string; user: string }[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const app = await setup({
    ai: true,
    systemTemplate: '系统状态={{ im_status }}',
    userTemplate: '用户状态={{im_status}}\n{{input}}',
    driver: {
      id: 'driver',
      async generate(request) {
        prompts.push({
          system: request.systemPrompt,
          user: request.messages
            .at(-1)!
            .content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join(''),
        })
        if (prompts.length === 1) await gate
        return { content: [{ type: 'text', text: prompts.length === 1 ? block(raw) : '收到' }] }
      },
    },
  })
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: { userInputTemplate: '接入状态={{ im_status }}\n{{last_message}}' },
  })
  try {
    await app.connection.receive('/ai 第一轮')
    await poll(() => prompts.length).toBe(1)
    await app.connection.receive('/ai 原文 {{im_status}}', { id: 'queued-message' })
    expect((await app.jobs()).some((job) => job.status === 'queued')).toBe(true)
  } finally {
    release()
  }
  await settled(app, 2)
  expect(prompts[0]!.system).toBe('系统状态=')
  expect(prompts[1]!.system).toBe(`系统状态=${raw}`)
  expect(prompts[1]!.user).toContain(`用户状态=${raw}\n接入状态=${raw}\n`)
  expect(prompts[1]!.user).toContain('/ai 原文 {{im_status}}')
  const jobs = await app.jobs()
  expect(jobs[1]!.input).toContain(`接入状态=${raw}`)
  expect(await statuses(app)).toEqual([
    { workspace_id: app.messages[0]!.workspaceId, content: raw },
  ])
})

it('文件数据库重开、插件重载和 reset 保留状态，空状态块清空，变量随插件回收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-im-status-'))
  directories.push(directory)
  const databaseFilename = join(directory, 'status.sqlite')
  let answer = block()
  const prompts: string[] = []
  const driver: ModelDriver = {
    id: 'driver',
    async generate(request) {
      prompts.push(request.systemPrompt)
      return { content: [{ type: 'text', text: answer }] }
    },
  }
  const options = { ai: true, databaseFilename, systemTemplate: '状态={{ im_status }}', driver }
  const first = await setup(options)
  await first.connection.receive('/ai 保存')
  await settled(first, 1)
  expect(first.sent).toHaveLength(0)
  expect(first.ctx.ai.listTemplateVariables()).toContainEqual(
    expect.objectContaining({ id: 'im_status', description: expect.any(String) }),
  )
  await first.aiPlugin!.dispose()
  expect(first.ctx.ai.listTemplateVariables().some((item) => item.id === 'im_status')).toBe(false)
  await first.ctx.plugin(imAi, { pollIntervalMs: 20 })
  answer = '不更新'
  await first.connection.receive('/ai 重载后')
  await settled(first, 2)
  expect(prompts[1]).toBe(`状态=${content}`)
  await cleanup()

  const second = await setup(options)
  await second.connection.receive('/reset')
  await second.connection.receive('/ai 重开数据库并重置上下文后')
  await settled(second, 3)
  expect(prompts[2]).toBe(`状态=${content}`)
  expect(await statuses(second)).toEqual([
    { workspace_id: second.messages[0]!.workspaceId, content },
  ])
  answer = block('')
  await second.connection.receive('/ai 清空')
  await settled(second, 4)
  expect((await statuses(second))[0]!.content).toBe('')
  answer = '普通回复'
  await second.connection.receive('/ai 清空之后')
  await settled(second, 5)
  expect(prompts.at(-1)).toBe('状态=')
})

it('整份预检失败不覆盖旧状态、不先发正常正文', async () => {
  let answer = block()
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return { content: [{ type: 'text', text: answer }] }
      },
    },
  })
  await app.connection.receive('/ai 保存旧状态')
  await settled(app, 1)
  answer = `<im_reply>${block('不应保存')}<message>不应先发</message><message quote="foreign">无效引用</message></im_reply>`
  await app.connection.receive('/ai 无效回复')
  await settled(app, 2)
  expect((await app.jobs())[1]!.status).toBe('failed')
  expect(app.sent).toHaveLength(1)
  expect(app.sent[0]!.segments).toEqual([
    { type: 'text', text: 'AI 回复格式、引用或图片地址无效，本次回复未发送，请重试。' },
  ])
  expect((await statuses(app))[0]!.content).toBe(content)
})

it('回复投递失败仍保存状态，旧计划重试不重新运行模型或覆盖新状态', async () => {
  let answer = `<im_reply>${block('旧状态')}<message>旧回复</message></im_reply>`
  const generate = vi.fn<ModelDriver['generate']>(async () => ({
    content: [{ type: 'text', text: answer }],
  }))
  const app = await setup({ ai: true, deliveryAttempts: 1, driver: { id: 'driver', generate } })
  vi.spyOn(app.ctx.im, 'send').mockRejectedValueOnce(new Error('发送前连接断开'))
  await app.connection.receive('/ai 第一轮')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('failed')
  expect((await statuses(app))[0]!.content).toBe('旧状态')
  answer = block('新状态')
  await app.connection.receive('/ai 第二轮')
  await settled(app, 1)
  expect((await statuses(app))[0]!.content).toBe('新状态')
  await app.aiPlugin!.dispose()
  const oldJob = (await app.jobs())[0]!
  await statusDb(app)
    .updateTable('jobs')
    .set({ delivery: 'pending', attempts: 0 })
    .where('id', '=', oldJob.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await settled(app, 2)
  expect(generate).toHaveBeenCalledTimes(2)
  expect((await statuses(app))[0]!.content).toBe('新状态')
  expect(app.sent.map((entry) => entry.segments)).toEqual([[{ type: 'text', text: '旧回复' }]])
})

it('模型截断时不保存已经输出的状态块', async () => {
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return { content: [{ type: 'text', text: block() }], stopReason: 'length' }
      },
    },
  })
  await app.connection.receive('/ai 截断回复')
  await settled(app, 1)
  expect((await app.jobs())[0]!.status).toBe('failed')
  expect(await statuses(app)).toEqual([])
})

it('模型完成但预检尚未结束时 stop 阻止状态写入', async () => {
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return {
          content: [
            { type: 'text', text: `<im_reply>${block()}<message>正文</message></im_reply>` },
          ],
        }
      },
    },
  })
  const validate = app.ctx.im.validateSend.bind(app.ctx.im)
  let release!: () => void
  let validating = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const validation = vi
    .spyOn(app.ctx.im, 'validateSend')
    .mockImplementationOnce(async (...args) => {
      validating = true
      await gate
      return validate(...args)
    })
  try {
    await app.connection.receive('/ai 准备停止')
    await poll(() => validating).toBe(true)
    const runLookup = vi.spyOn(app.ctx.ai.running, 'get')
    const stop = app.connection.receive('/stop')
    try {
      await poll(() => runLookup.mock.calls.length).toBeGreaterThan(0)
    } finally {
      release()
      await stop
    }
  } finally {
    release()
    validation.mockRestore()
  }
  expect(await statuses(app)).toEqual([])
  expect(JSON.stringify(app.sent)).not.toContain('正文')
})
