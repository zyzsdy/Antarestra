import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { listenForTest } from '../../scripts/test-listen.js'
import { afterEach, expect, it, vi } from 'vitest'
import Storage, { type BlobUpload, type StorageBackend } from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import imAi from '@antarestra/plugin-im-ai'
import { imageResourceId, type MessageSegment, type ScopedTarget } from '@antarestra/im'
import { parseReply } from '../../plugins/features/im-ai/src/reply.js'
import { pluginId, type Tables } from '../../plugins/features/im-ai/src/store.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=',
  'base64',
)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })

async function storage(app: Awaited<ReturnType<typeof setup>>) {
  await app.ctx.plugin(Storage)
  const blobs = new Map<string, Uint8Array>()
  const tickets = new Map<string, { key: string; expiresAt: number }>()
  const server = createServer((request, response) => {
    const ticket = tickets.get(
      new URL(request.url!, 'http://localhost').searchParams.get('token') ?? '',
    )
    if (!ticket || ticket.expiresAt <= Date.now() || !blobs.has(ticket.key)) {
      response.writeHead(410).end()
      return
    }
    response.setHeader('Content-Type', 'image/png')
    response.end(Buffer.from(blobs.get(ticket.key)!))
  })
  await listenForTest(server)
  app.ctx.effect(
    () => () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试存储监听失败')
  const temporaryUrl = vi.fn(async (key: string) => {
    const token = randomUUID(),
      expiresAt = Date.now() + 60_000
    tickets.set(token, { key, expiresAt })
    return {
      url: `http://127.0.0.1:${address.port}/image?token=${token}`,
      expiresAt,
    }
  })
  const backend: StorageBackend = {
    async begin(upload) {
      return upload
    },
    async plan(upload) {
      return {
        driver: 'test',
        headers: {},
        parts: [{ number: 1, url: upload.stagingKey, offset: 0, size: upload.size }],
      }
    },
    async write(upload, data) {
      blobs.set(upload.stagingKey, data)
      return []
    },
    async complete(upload) {
      blobs.set(upload.key, blobs.get(upload.stagingKey)!)
    },
    async discard(upload: BlobUpload) {
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
    async download() {
      throw new Error('普通下载需要登录，不能用于发图')
    },
    temporaryUrl,
  }
  app.ctx.storage.register(app.ctx, 'test', backend)
  const fiber = await app.ctx.plugin(files, { backendId: 'test' })
  await app.connection.receive('建立空间')
  const message = app.messages.at(-1)!
  const access = await app.ctx.workspaceFile.authorize('im', message.request)
  const photo = await app.ctx.workspaceFile.writeAttachment(
    access,
    { filename: 'photo.png', mimeType: 'image/png', data: png },
    new AbortController().signal,
  )
  const target: ScopedTarget = {
    connectionId: 'qq-a',
    workspaceId: message.workspaceId,
    chat: message.message.chat,
  }
  const segments: MessageSegment[] = [{ type: 'image', url: `resource://${photo.id}` }]
  return { backend, blobs, temporaryUrl, fiber, photo, access, target, segments }
}

it('图片和表情包解析简短资源引用并保留 ID 大小写，拒绝路径及参数', () => {
  for (const capabilities of [[], ['image.key']]) {
    expect(
      parseReply(
        '<im_reply><image>resource://Photo_A</image><sticker>resource://Photo_B</sticker></im_reply>',
        capabilities,
      ),
    ).toEqual([
      [{ type: 'image', url: 'resource://Photo_A' }],
      [{ type: 'image', url: 'resource://Photo_B' }],
    ])
  }
  expect(imageResourceId('resource://Photo_A')).toBe('Photo_A')
  expect(imageResourceId('resource://objects%2FPhoto_A')).toBe('objects/Photo_A')
  for (const src of [
    'resource://',
    'resource:///id',
    'resource://id/path',
    'resource://id?x=1',
    'resource://id#x',
    'resource://user@id',
    'resource://%00',
    'resource://%FF',
  ])
    expect(() => parseReply(`<im_reply><image>${src}</image></im_reply>`)).toThrow()
})

it('AI 工具获得稳定引用，非 S3 provider 提供真正免鉴权图片 URL，回复和归档不保存临时凭证', async () => {
  let id = ''
  const app = await setup({
    ai: true,
    toolIds: ['im_prepare_image'],
    driver: {
      id: 'driver',
      async generate(request) {
        const tool = request.messages
          .flatMap((m) => m.content)
          .find((b) => b.type === 'tool-result')
        if (tool)
          expect(tool).toMatchObject({
            isError: false,
            content: { src: `resource://${id}`, resourceId: id },
          })
        return {
          content: request.messages.some((m) => m.role === 'tool')
            ? [
                {
                  type: 'text',
                  text: `<im_reply><image>resource://${id}</image><sticker>resource://${id}</sticker></im_reply>`,
                },
              ]
            : [
                {
                  type: 'tool-call',
                  id: 'prepare',
                  name: 'im_prepare_image',
                  arguments: { resourceId: id },
                },
              ],
        }
      },
    },
  })
  const state = await storage(app)
  id = state.photo.id
  await app.ctx.im.validateSend(state.target, state.segments)
  expect(state.temporaryUrl).not.toHaveBeenCalled()
  await app.connection.receive('/ai 发图')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(app.sent).toHaveLength(2)
  for (const sent of app.sent) {
    const segment = sent.segments[0]!
    if (segment.type !== 'image') throw new Error('不是图片')
    const response = await fetch(segment.url)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
  }
  const job = (await app.jobs())[0]!
  expect(job.reply_plan).toContain(`resource://${id}`)
  expect(job.reply_plan).not.toContain('token=')
  const history = await app.ctx.im.history(state.target.workspaceId)
  expect(
    history.filter((m) => m.message.sender.bot).map((m) => m.media[0]?.resource?.resourceId),
  ).toEqual([id, id])
  expect(JSON.stringify(history)).not.toContain('token=')
  expect([...state.blobs.keys()].filter((key) => key.startsWith('objects/'))).toHaveLength(1)
})

it('跨空间图片使整份回复预检失败，不能先发送前面的文本', async () => {
  let id = ''
  const app = await setup({
    ai: true,
    driver: {
      id: 'driver',
      async generate() {
        return {
          content: [
            {
              type: 'text',
              text: `<im_reply><message>不可先发</message><image>resource://${id}</image></im_reply>`,
            },
          ],
        }
      },
    },
  })
  const state = await storage(app)
  const foreign = await app.ctx.workspaceFile.groupArchiveAccess(app.ctx, 'other', 'other')
  id = (
    await app.ctx.workspaceFile.writeAttachment(
      foreign,
      { filename: 'other.png', mimeType: 'image/png', data: png },
      new AbortController().signal,
    )
  ).id
  await app.connection.receive('/ai 发图')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect((await app.jobs())[0]?.status).toBe('failed')
  expect(app.sent).toHaveLength(1)
  expect(app.sent[0]?.segments).toEqual([
    { type: 'text', text: 'AI 回复格式、引用或图片地址无效，本次回复未发送，请重试。' },
  ])
  expect(state.temporaryUrl).not.toHaveBeenCalled()
})

it('排队期间不签发链接；临时地址失败可安全重试，已发送记录不依赖图片仍存在', async () => {
  const app = await setup()
  const state = await storage(app)
  let release!: () => void, entered!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = app.ctx.im.send(state.target, [{ type: 'text', text: '前一条' }], {
    beforeSend: async () => {
      entered()
      await barrier
    },
  })
  await waiting
  const second = app.ctx.im.send(state.target, state.segments, { idempotencyKey: 'image' })
  expect(state.temporaryUrl).not.toHaveBeenCalled()
  state.temporaryUrl.mockRejectedValueOnce(new Error('暂时无法签名'))
  const failure = expect(second).rejects.toThrow('暂时无法签名')
  release()
  await first
  await failure
  expect(app.sent).toHaveLength(1)
  const result = await app.ctx.im.send(state.target, state.segments, { idempotencyKey: 'image' })
  expect(app.sent).toHaveLength(2)
  await app.ctx.workspaceFile.removeResource(state.access, state.photo.id)
  expect(await app.ctx.im.send(state.target, state.segments, { idempotencyKey: 'image' })).toEqual(
    result,
  )
  expect(app.sent).toHaveLength(2)
  expect(state.temporaryUrl).toHaveBeenCalledTimes(2)
})

it('恢复持久化回复时重新生成临时地址，不重新调用模型', async () => {
  let id = ''
  const generate = vi.fn(async () => ({
    content: [
      { type: 'text' as const, text: `<im_reply><image>resource://${id}</image></im_reply>` },
    ],
  }))
  const app = await setup({ ai: true, deliveryAttempts: 1, driver: { id: 'driver', generate } })
  const state = await storage(app)
  id = state.photo.id
  state.temporaryUrl.mockRejectedValueOnce(new Error('签名服务暂时不可用'))
  await app.connection.receive('/ai 发图')
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('failed')
  const job = (await app.jobs())[0]!
  await app.aiPlugin!.dispose()
  await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .updateTable('jobs')
    .set({ delivery: 'pending', attempts: 0 })
    .where('id', '=', job.id)
    .execute()
  await app.ctx.plugin(imAi, { pollIntervalMs: 20 })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(generate).toHaveBeenCalledTimes(1)
  expect(state.temporaryUrl).toHaveBeenCalledTimes(2)
  expect(app.sent).toHaveLength(1)
})

it('文件扩展独立卸载后拒绝内部资源，重载后恢复；取消在途签名不会投递', async () => {
  const app = await setup()
  const state = await storage(app)
  await state.fiber.dispose()
  await expect(app.ctx.im.validateSend(state.target, state.segments)).rejects.toThrow('能力不可用')
  const fiber = await app.ctx.plugin(files, { backendId: 'test' })
  await app.ctx.im.validateSend(state.target, state.segments)
  let resolve!: (value: { url: string; expiresAt: number }) => void
  state.temporaryUrl.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const sending = app.ctx.im.send(state.target, state.segments, { idempotencyKey: 'cancel' })
  const failed = expect(sending).rejects.toThrow()
  await poll(() => state.temporaryUrl.mock.calls.length).toBe(1)
  const disposed = fiber.dispose()
  resolve({ url: 'https://example.com/image.png', expiresAt: Date.now() + 60_000 })
  await disposed
  await failed
  expect(app.sent).toHaveLength(0)
  await app.ctx.plugin(files, { backendId: 'test' })
  await app.ctx.im.send(state.target, state.segments, { idempotencyKey: 'cancel' })
  expect(app.sent).toHaveLength(1)
})
