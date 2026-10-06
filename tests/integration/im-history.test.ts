import { afterEach, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import Storage, { type StorageBackend } from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import imAi from '@antarestra/plugin-im-ai'
import type { MediaSegment } from '@antarestra/im'
import type { RequestSnapshot } from '@antarestra/ai'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })
async function storage(app: Awaited<ReturnType<typeof setup>>) {
  const blobs = new Map<string, Uint8Array>()
  const backend: StorageBackend = {
    async begin(upload) {
      return upload
    },
    async plan(upload) {
      return {
        driver: 'memory',
        headers: {},
        parts: [{ number: 1, url: upload.stagingKey, offset: 0, size: upload.size }],
      }
    },
    async write(upload, data, signal) {
      signal.throwIfAborted()
      blobs.set(upload.stagingKey, data)
      return []
    },
    async complete(upload) {
      blobs.set(upload.key, blobs.get(upload.stagingKey)!)
    },
    async discard(upload) {
      blobs.delete(upload.stagingKey)
    },
    async remove(key) {
      blobs.delete(key)
    },
    async read(key) {
      return blobs.get(key)!
    },
    async exists(key) {
      return blobs.has(key)
    },
    async download(key) {
      return `https://example.invalid/${key}`
    },
  }
  await app.ctx.plugin(Storage)
  app.ctx.storage.register(app.ctx, 'test', backend)
  const fiber = await app.ctx.plugin(files, { backendId: 'test', defaultQuota: 1000 })
  return { fiber, blobs, backend }
}
const download = async (_message: unknown, media: MediaSegment) => ({
  data: new Uint8Array([1, 2, 3]),
  mimeType: media.type === 'image' ? 'image/png' : 'application/pdf',
  filename: media.name ?? 'file.pdf',
})

it('不依赖 AI 激活归档群文本、命令和机器人；去重并保持原始引用，私聊不存档', async () => {
  const app = await setup()
  await app.connection.receive('周会 100% 计划', {
    id: 'original',
    timestamp: 1000,
    raw: { original: true },
  })
  const workspaceId = app.messages[0]!.workspaceId
  await app.connection.receive('/ping', { id: 'command' })
  await app.connection.receive('机器人公告', { id: 'bot', sender: { id: 'other-bot', bot: true } })
  await app.connection.receive('自己', { id: 'self', sender: { id: '05' } })
  await app.connection.receive('重复', { id: 'original' })
  const history = await app.ctx.im.history(workspaceId)
  expect(history.filter((entry) => entry.message.id === 'original')).toHaveLength(1)
  expect(history.map((entry) => entry.message.id)).toEqual(
    expect.arrayContaining(['original', 'command', 'bot', 'self']),
  )
  expect(history[0]?.message.raw).toEqual({ original: true })
  expect(
    await app.ctx.im.history(workspaceId, {
      senderId: '79338528',
      startTime: 0,
      endTime: 1001,
      keyword: '100%',
    }),
  ).toHaveLength(1)
  expect(await app.ctx.im.history('foreign')).toEqual([])
  await app.ctx.im.send(
    { workspaceId, connectionId: 'qq-a', chat: { type: 'group', id: '40894918' } },
    [
      { type: 'reply', messageId: 'original' },
      { type: 'text', text: '引用成功' },
    ],
  )
  const privateChat = await app.connect('private', '09', {
    private: { mode: 'blacklist', ids: [] },
  })
  await privateChat.receive('私聊不存', { chat: { type: 'private', id: 'user' } })
  expect(await app.ctx.im.history(app.messages.at(-1)!.workspaceId)).toEqual([])
})

it('未读游标与请求快照持久化，重载后不重复读取，最后消息模板不附带历史', async () => {
  const app = await setup({
    ai: true,
    userTemplate: '{{history_message}}\n本条={{last_message}}\n原因={{active_reason}}',
  })
  await app.connection.receive('旧闲聊')
  await app.connection.receive('/ai 第一次')
  await poll(() => app.aiState.calls).toBe(1)
  await poll(() => app.sent.length).toBe(1)
  const first = (await app.jobs())[0]!
  const snapshot = JSON.parse(first.snapshot!)
  expect(snapshot.history_message).toContain('旧闲聊')
  expect(snapshot.history_message).not.toContain('/ai 第一次')
  expect(snapshot.last_message).toContain('/ai 第一次')
  expect(first.input.match(/\/ai 第一次/g)).toHaveLength(1)
  const access = await app.ctx.ai.authorize('im', app.messages[0]!.request)
  const run = await app.ctx.ai.getRun(access, first.run_id!)
  expect(JSON.stringify(run.messages)).toContain('原因=命令')
  await app.aiPlugin!.dispose()
  await app.connection.receive('离线期间的闲聊')
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await app.connection.receive('/ai 第二次')
  await poll(() => app.aiState.calls).toBe(2)
  expect((await app.jobs())[1]?.input).toContain('离线期间的闲聊')
  expect((await app.jobs())[1]?.input).not.toContain('旧闲聊')
  await app.ctx.im.setPolicy('qq-a', {
    ...app.defaultPolicy,
    defaults: { userInputTemplate: '{{last_message}}' },
  })
  await app.connection.receive('不会作为输入发送')
  await app.connection.receive('/ai 只发最后')
  expect((await app.jobs())[2]?.input).not.toContain('不会作为输入发送')
})

it.each([false, true])(
  '触发消息不占历史条数，当前媒体只随 last_message 附带：%s',
  async (includeLast) => {
    const app = await setup({ ai: true, modelInput: ['text', 'image'] })
    await storage(app)
    const connection = await app.connect(
      'template-media',
      '06',
      {
        ...app.defaultPolicy,
        defaults: {
          historyLimit: 1,
          userInputTemplate: includeLast
            ? '{{ history_message }}\n{{ last_message }}'
            : '{{ history_message }}',
        },
      },
      download,
    )
    await connection.receive('应保留的历史')
    await connection.receive('/ai 当前图片', {
      segments: [
        { type: 'text', text: '/ai 当前图片' },
        { type: 'image', url: 'https://example.invalid/current.png' },
      ],
    })
    const snapshot = JSON.parse((await app.jobs())[0]!.snapshot!)
    expect(snapshot.history_message).toContain('应保留的历史')
    expect(snapshot.history_message).not.toContain('当前图片')
    expect(snapshot.history_message).not.toContain('[图片')
    expect(snapshot.last_message).toContain('当前图片')
    expect(snapshot.attachments).toHaveLength(includeLast ? 1 : 0)
  },
)

it('默认群模板在没有历史时仍包含当前消息且历史变量为空', async () => {
  const app = await setup({ ai: true })
  await app.connection.receive('/ai 首条消息')
  const job = (await app.jobs())[0]!
  expect(JSON.parse(job.snapshot!).history_message).toBe('')
  expect(job.input.match(/\/ai 首条消息/g)).toHaveLength(1)
})

it('媒体保存到空间文件，7 天清理及容量淘汰只删除群媒体；文本与原始信息保留', async () => {
  const app = await setup()
  const store = await storage(app)
  const connection = await app.connect('media', '06', app.defaultPolicy, download)
  const timestamp = Date.now() - 6 * 86400000
  await connection.receive('带媒体', {
    id: 'image',
    timestamp,
    segments: [
      { type: 'text', text: '保留正文' },
      { type: 'image', url: 'https://example.invalid/a', name: 'a.png' },
    ],
  })
  const message = app.messages.at(-1)!
  const first = (await app.ctx.im.history(message.workspaceId))[0]!
  expect(first.media[0]?.status).toBe('stored')
  const access = await app.ctx.workspaceFile.authorize('im', message.request)
  const manual = await app.ctx.workspaceFile.writeAttachment(
    access,
    { filename: 'manual.txt', mimeType: 'text/plain', data: new Uint8Array([4]) },
    message.signal,
  )
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400000)
  try {
    await app.ctx.workspaceFile.sweep()
  } finally {
    clock.mockRestore()
  }
  expect((await app.ctx.im.history(message.workspaceId))[0]?.media[0]?.status).toBe('expired')
  expect((await app.ctx.im.history(message.workspaceId))[0]?.message.segments[0]).toEqual({
    type: 'text',
    text: '保留正文',
  })
  expect(await app.ctx.workspaceFile.resource(access, manual.id)).toMatchObject({ id: manual.id })
  await app.ctx.im.setPolicy('media', {
    ...app.defaultPolicy,
    defaults: { mediaRetentionDays: 0, mediaMaxBytes: 3 },
  })
  await connection.receive('一', {
    id: 'file1',
    segments: [{ type: 'file', url: 'https://example.invalid/1' }],
  })
  await connection.receive('二', {
    id: 'file2',
    segments: [{ type: 'video', url: 'https://example.invalid/2' }],
  })
  const latest = await app.ctx.im.history(message.workspaceId)
  expect(latest.find((entry) => entry.message.id === 'file1')?.media[0]?.status).toBe('expired')
  expect(latest.find((entry) => entry.message.id === 'file2')?.media[0]?.status).toBe('stored')
  expect(store.blobs.size).toBe(2)
  await expect(
    app.ctx.workspaceFile.resource(
      await app.ctx.workspaceFile.groupArchiveAccess(app.ctx, 'foreign', '其他空间'),
      manual.id,
    ),
  ).rejects.toMatchObject({ status: 410 })
})

it('按时间自动附带最后五张图片和最后一个文件，超限图片可按标签 ID 用文件工具读取', async () => {
  const requests: RequestSnapshot[] = []
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII='
  let omittedId = ''
  const app = await setup({
    ai: true,
    contextWindow: 100000,
    modelInput: ['text', 'image', 'file'],
    toolIds: ['workspace_file_read'],
    driver: {
      id: 'driver',
      async generate(input, connection) {
        requests.push(input)
        if (requests.length === 1) {
          const text = input.messages
            .flatMap((message) => message.content)
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n')
          omittedId = text.match(/\[图片,([^\]]+)\]/)![1]!
          expect(connection.resources?.has(omittedId)).toBe(false)
          return {
            content: [
              {
                type: 'tool-call',
                id: 'read-omitted-image',
                name: 'workspace_file_read',
                arguments: { resourceId: omittedId },
              },
            ],
          }
        }
        expect(connection.resources?.get(omittedId)).toEqual({
          filename: '0.png',
          mimeType: 'image/png',
          data: png,
        })
        expect(input.messages.flatMap((message) => message.content)).toContainEqual(
          expect.objectContaining({
            type: 'tool-result',
            id: 'read-omitted-image',
            isError: false,
            images: [expect.objectContaining({ resourceId: omittedId, width: 1, height: 1 })],
          }),
        )
        return { content: [{ type: 'text', text: '完成' }] }
      },
    },
  })
  await storage(app)
  const connection = await app.connect(
    'images',
    '07',
    { ...app.defaultPolicy, defaults: { maxImages: 5, maxFiles: 1, historyLimit: 20 } },
    async (message, media) => ({
      ...(await download(message, media)),
      data: media.type === 'image' ? Buffer.from(png, 'base64') : new Uint8Array([1, 2, 3]),
    }),
  )
  for (let index = 0; index < 7; index++)
    await connection.receive('', {
      id: `img${index}`,
      segments: [{ type: 'image', url: `https://example.invalid/${index}`, name: `${index}.png` }],
    })
  for (let index = 0; index < 2; index++)
    await connection.receive('', {
      id: `file${index}`,
      segments: [
        { type: 'file', url: `https://example.invalid/file${index}`, name: `${index}.pdf` },
      ],
    })
  await connection.receive('/ai 总结')
  await poll(() => app.sent.length).toBe(1)
  expect(requests).toHaveLength(2)
  const input = (await app.jobs())[0]!
  const snapshot = JSON.parse(input.snapshot!)
  expect(snapshot.attachments.map((file: { filename: string }) => file.filename)).toEqual([
    '2.png',
    '3.png',
    '4.png',
    '5.png',
    '6.png',
    '1.pdf',
  ])
  expect(snapshot.history_message).toContain('[图片（附件1）,')
  expect(snapshot.history_message).toContain('[文件（附件6）,')
  expect(snapshot.history_message.match(/\[图片,/g)).toHaveLength(2)
  expect(
    requests[0]!.messages.at(-1)!.content.filter((part) => part.type === 'image'),
  ).toHaveLength(5)
  const access = await app.ctx.ai.authorize('im', app.messages.at(-1)!.request)
  const run = await app.ctx.ai.getRun(access, input.run_id!)
  expect(run.status).toBe('completed')
  expect(JSON.stringify(run)).not.toContain(png)
})

it('媒体失败保留记录并重试；卸载文件扩展取消并等待下载', async () => {
  const app = await setup()
  const store = await storage(app)
  let attempts = 0
  const connection = await app.connect('retry', '08', app.defaultPolicy, async (...args) => {
    attempts++
    if (attempts === 1) throw new Error('临时故障')
    return download(args[0], args[1])
  })
  await connection.receive('', {
    segments: [{ type: 'image', url: 'https://example.invalid/image' }],
  })
  const workspace = app.messages.at(-1)!.workspaceId
  expect((await app.ctx.im.history(workspace))[0]?.media[0]?.status).toBe('failed')
  await app.ctx.im.maintainHistory()
  expect((await app.ctx.im.history(workspace))[0]?.media[0]?.status).toBe('stored')
  let started = false,
    aborted = false
  const slow = await app.connect(
    'slow',
    '10',
    app.defaultPolicy,
    async (_message, _media, signal) => {
      started = true
      try {
        await delay(60000, undefined, { signal })
      } finally {
        aborted = signal.aborted
      }
      return { data: new Uint8Array(), mimeType: 'image/png', filename: 'slow.png' }
    },
  )
  const pending = slow
    .receive('', { segments: [{ type: 'image', url: 'https://example.invalid/slow' }] })
    .catch(() => {})
  await poll(() => started).toBe(true)
  await store.fiber.dispose()
  await pending
  expect(aborted).toBe(true)
})

it('真实工具执行按可信空间查询，拒绝模型指定外部空间并支持时间发送人关键词过滤', async () => {
  const requests: RequestSnapshot[] = []
  let calls = 0
  const app = await setup({
    ai: true,
    toolIds: ['im_history_query'],
    driver: {
      id: 'driver',
      async generate(request) {
        requests.push(request)
        calls++
        if (calls === 1)
          return {
            content: [
              {
                type: 'tool-call',
                id: 'bad',
                name: 'im_history_query',
                arguments: { workspaceId: 'foreign' },
              },
            ],
          }
        if (calls === 2)
          return {
            content: [
              {
                type: 'tool-call',
                id: 'good',
                name: 'im_history_query',
                arguments: {
                  keyword: '预算',
                  senderId: '79338528',
                  startTime: '2026-10-01T00:00:00Z',
                  endTime: '2026-10-02T00:00:00Z',
                  limit: 2,
                },
              },
            ],
          }
        return { content: [{ type: 'text', text: '查询完成' }] }
      },
    },
  })
  const other = await app.connect('foreign', '11')
  await other.receive('预算机密', { timestamp: Date.parse('2026-10-01T01:00:00Z') })
  await app.connection.receive('预算 123', {
    id: 'budget',
    timestamp: Date.parse('2026-10-01T02:00:00Z'),
  })
  await app.connection.receive('预算不在范围', { timestamp: Date.parse('2026-10-02T02:00:00Z') })
  await app.connection.receive('/ai 查询')
  await poll(() => app.sent.length).toBe(1)
  const first = (await app.jobs())[0]!
  const access = await app.ctx.ai.authorize('im', app.messages.at(-1)!.request)
  const rejected = await app.ctx.ai.getRun(access, first.run_id!)
  expect(rejected.error?.code).toBe('invalid_request')
  await app.connection.receive('/reset')
  await app.connection.receive('/ai 查询')
  await poll(() => app.sent.length).toBe(3)
  const results = requests
    .at(-1)!
    .messages.flatMap((message) => message.content)
    .filter((part) => part.type === 'tool-result')
  const query = JSON.stringify(results.find((result) => result.id === 'good')?.content)
  expect(query).toContain('budget')
  expect(query).toContain('预算 123')
  expect(query).not.toContain('预算机密')
  expect(query).not.toContain('预算不在范围')
})

it('私聊图片进入原 AI 会话附件，不进入群归档或群媒体清理', async () => {
  const app = await setup({ ai: true, contextWindow: 100000, modelInput: ['text', 'image'] })
  await storage(app)
  const privateChat = await app.connect(
    'private-media',
    '12',
    { private: { mode: 'blacklist', ids: [], defaults: { ai: true, agentId: 'assistant' } } },
    download,
  )
  await privateChat.receive('', {
    chat: { type: 'private', id: 'user' },
    segments: [{ type: 'image', url: 'https://example.invalid/private.png' }],
  })
  await poll(() => app.sent.length).toBe(1)
  const message = app.messages.at(-1)!
  expect(await app.ctx.im.history(message.workspaceId)).toEqual([])
  const snapshot = JSON.parse((await app.jobs())[0]!.snapshot!)
  expect(snapshot.attachments).toHaveLength(1)
  await app.ctx.workspaceFile.retainGroupArchive(app.ctx, message.workspaceId, 1, 1)
  const access = await app.ctx.workspaceFile.authorize('im', message.request)
  expect(
    await app.ctx.workspaceFile.resource(access, snapshot.attachments[0].resourceId),
  ).toMatchObject({ size: 3 })
})

it('群消息中的模板字样作为原文传送，不递归替换其他消息', async () => {
  let request: RequestSnapshot | undefined
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate(input) {
        request = input
        return { content: [{ type: 'text', text: '完成' }] }
      },
    },
  })
  await app.connection.receive('原文 {{last_message}} {{history_message}}')
  await app.connection.receive('/ai 总结')
  await poll(() => app.sent.length).toBe(1)
  expect(JSON.stringify(request)).toContain('原文 {{last_message}} {{history_message}}')
})
