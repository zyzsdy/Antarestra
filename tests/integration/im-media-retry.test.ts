import { afterEach, expect, it, vi } from 'vitest'
import im, { type ConnectionHandle, type IncomingMessage, type MediaArchive } from '@antarestra/im'
import type { Message } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { pluginId, type Tables } from '../../plugins/definitions/im/src/schema.js'
import { describeArchiveError } from '../../plugins/definitions/im/src/diagnostics.js'
import { formatMessage } from '../../plugins/implementations/logger/src/format.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)

function archive(app: Awaited<ReturnType<typeof setup>>) {
  const store = vi.fn<MediaArchive['store']>(async (_message, media, download, signal) => {
    const result = await download(1000, signal)
    return {
      resourceId: media.id,
      mimeType: result.mimeType,
      filename: result.filename,
      size: result.data.byteLength,
    }
  })
  const dispose = app.ctx.im.registerMediaArchive(app.ctx, {
    store,
    retain: async () => {},
    available: async () => true,
  })
  return { store, dispose }
}

it('归档准备期间撤销聊天准入，核心在下载前重新检查已保存策略', async () => {
  const app = await setup()
  const download = vi.fn(async () => ({
    data: new Uint8Array([1]),
    mimeType: 'image/png',
    filename: 'test.png',
  }))
  const connection = await app.connect('revoked', '08', app.defaultPolicy, download)
  let workspace = ''
  app.ctx.im.registerMediaArchive(app.ctx, {
    async store(message, media, load, signal) {
      workspace = message.workspaceId
      await app.ctx.im.setPolicy('revoked', { ...app.defaultPolicy, enabled: false })
      const result = await load(1000, signal)
      return {
        resourceId: media.id,
        mimeType: result.mimeType,
        filename: result.filename,
        size: result.data.byteLength,
      }
    },
    retain: async () => {},
    available: async () => true,
  })
  await connection.receive('归档时禁用', {
    segments: [{ type: 'image', url: 'https://example.invalid/image' }],
  })
  expect(download).not.toHaveBeenCalled()
  expect((await app.ctx.im.history(workspace))[0]?.media[0]).toMatchObject({
    status: 'failed',
    lastError: expect.stringContaining('禁用'),
  })
})

it('默认最多重试十次，插件重载继续累计，耗尽后退出队列并输出可定位的失败原因', async () => {
  const app = await setup()
  archive(app)
  const logs: Message[] = []
  app.ctx.logger.exporter({ export: (message) => logs.push(message) })
  const download = vi.fn(async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' }),
    })
  })
  const connection = await app.connect('retry-limit', '08', app.defaultPolicy, download)
  await connection.receive('正文仍保留', {
    id: 'failed-image',
    segments: [
      { type: 'text', text: '正文仍保留' },
      { type: 'image', url: 'https://example.invalid/image?token=secret' },
    ],
  })
  const workspace = app.messages.at(-1)!.workspaceId
  for (let index = 0; index < 5; index++) await app.ctx.im.maintainHistory()
  expect(download).toHaveBeenCalledTimes(6)
  expect((await app.ctx.im.history(workspace))[0]?.media[0]).toMatchObject({
    status: 'failed',
    attempts: 6,
  })

  await app.imPlugin.dispose()
  await app.ctx.plugin(im)
  await app.connect('retry-limit', '08', app.defaultPolicy, download)
  archive(app)
  for (let index = 0; index < 20; index++) await app.ctx.im.maintainHistory()
  expect(download).toHaveBeenCalledTimes(11)
  const message = (await app.ctx.im.history(workspace))[0]!
  expect(message.message.segments[0]).toEqual({ type: 'text', text: '正文仍保留' })
  expect(message.media[0]).toMatchObject({
    status: 'failed',
    attempts: 11,
    lastError: expect.stringContaining('ECONNRESET'),
  })
  const row = await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .selectFrom('history')
    .select('media_pending')
    .where('id', '=', message.id)
    .executeTakeFirstOrThrow()
  expect(row.media_pending).toBe(0)

  const failures = logs.filter((log) => log.args[0]?.toString().startsWith('群消息媒体保存失败'))
  expect(failures.filter((log) => log.type === 'warn')).toHaveLength(10)
  expect(failures.filter((log) => log.type === 'error')).toHaveLength(1)
  expect(failures.at(-1)?.args[1]).toMatchObject({
    connectionId: 'retry-limit',
    platform: 'qq',
    workspaceId: workspace,
    chatId: '40894918',
    messageId: 'failed-image',
    mediaId: message.media[0]!.id,
    mediaIndex: 1,
    mediaType: 'image',
    attempts: 11,
    retries: 10,
    maxRetries: 10,
  })
  const rendered = formatMessage(failures.at(-1)!)
  expect(rendered).toContain('停止自动重试')
  expect(rendered).toContain('fetch failed')
  expect(rendered).toContain('ECONNRESET')
  expect(rendered).not.toContain('secret')
})

it.each([0, 2])(
  '自定义重试上限 %i，对同一消息的多个媒体分别计数，成功媒体不再下载',
  async (maxRetries) => {
    const app = await setup({ imConfig: { mediaMaxRetries: maxRetries } })
    archive(app)
    const download = vi.fn(async (_message: IncomingMessage, media: { url: string }) => {
      if (media.url.endsWith('bad')) throw new Error('文件大小超过上限')
      return { data: new Uint8Array([1]), filename: 'ok.png', mimeType: 'image/png' }
    })
    const connection = await app.connect('mixed', '08', app.defaultPolicy, download)
    await connection.receive('', {
      segments: [
        { type: 'image', url: 'https://example.invalid/ok' },
        { type: 'image', url: 'https://example.invalid/bad' },
        { type: 'file', url: 'https://example.invalid/bad' },
      ],
    })
    for (let index = 0; index < 5; index++) await app.ctx.im.maintainHistory()
    const media = (await app.ctx.im.history(app.messages.at(-1)!.workspaceId))[0]!.media
    expect(media.map(({ status, attempts }) => ({ status, attempts }))).toEqual([
      { status: 'stored', attempts: 1 },
      { status: 'failed', attempts: maxRetries + 1 },
      { status: 'failed', attempts: maxRetries + 1 },
    ])
    expect(download).toHaveBeenCalledTimes(1 + (maxRetries + 1) * 2)
  },
)

it('未启用归档不消耗次数，旧失败记录仍受上限约束，成功重试清除旧原因', async () => {
  const app = await setup({ imConfig: { mediaMaxRetries: 1 } })
  const download = vi.fn(async () => ({
    data: new Uint8Array([1]),
    filename: 'ok.png',
    mimeType: 'image/png',
  }))
  const connection = await app.connect('legacy', '08', app.defaultPolicy, download)
  await connection.receive('', { segments: [{ type: 'image', url: 'https://example.invalid/a' }] })
  const workspace = app.messages.at(-1)!.workspaceId
  for (let index = 0; index < 3; index++) await app.ctx.im.maintainHistory()
  const message = (await app.ctx.im.history(workspace))[0]!
  expect(message.media[0]).toMatchObject({ status: 'pending' })
  expect(message.media[0]?.attempts).toBeUndefined()
  expect(download).not.toHaveBeenCalled()
  // 模拟升级前数据库中没有次数的失败记录。
  message.media[0]!.status = 'failed'
  message.media[0]!.lastError = '临时故障'
  await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .updateTable('history')
    .set({ payload: JSON.stringify(message) })
    .where('id', '=', message.id)
    .execute()
  archive(app)
  await Promise.all([app.ctx.im.maintainHistory(), app.ctx.im.maintainHistory()])
  expect(download).toHaveBeenCalledTimes(1)
  const media = (await app.ctx.im.history(workspace))[0]!.media[0]!
  expect(media).toMatchObject({ status: 'stored', attempts: 2 })
  expect(media.lastError).toBeUndefined()
})

it('卸载连接取消下载，不消耗取消资源的次数，也不丢失同消息先前资源的失败次数', async () => {
  const app = await setup({ imConfig: { mediaMaxRetries: 1 } })
  archive(app)
  const started = Promise.withResolvers<void>()
  let connection: ConnectionHandle | undefined
  const owner = await app.ctx.plugin({
    inject: ['im'],
    async apply(ctx) {
      connection = ctx.im.registerConnection(ctx, {
        id: 'cancel',
        accountId: '08',
        platform: 'qq',
        getMember: async () => ({ active: true }),
        send: async () => ({}),
        downloadMedia: async (_message, media, signal) => {
          if (media.type === 'image') throw new Error('图片下载失败')
          started.resolve()
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      })
      await ctx.im.setPolicy('cancel', app.defaultPolicy)
    },
  })
  const pending = connection!
    .receive({
      id: 'cancel-message',
      sender: { id: '79338528' },
      chat: { type: 'group', id: '40894918' },
      segments: [
        { type: 'image', url: 'https://example.invalid/image' },
        { type: 'file', url: 'https://example.invalid/file' },
      ],
    })
    .catch(() => {})
  await started.promise
  await owner.dispose()
  await pending
  const row = await app.ctx.database
    .scope<Tables>(app.ctx, pluginId)
    .selectFrom('history')
    .selectAll()
    .executeTakeFirstOrThrow()
  const message = (await app.ctx.im.history(row.workspace_id))[0]!
  expect(message.media[0]).toMatchObject({ status: 'failed', attempts: 1 })
  expect(message.media[1]).toMatchObject({ status: 'pending' })
  expect(message.media[1]?.attempts).toBeUndefined()
  expect(row.media_pending).toBe(1)
})

it.each([-1, 1.5, '10', null])('拒绝非法重试次数 %j', (mediaMaxRetries) => {
  expect(() =>
    schemaConfig(new URL('../../plugins/definitions/im/config.schema.json', import.meta.url), {
      mediaMaxRetries,
    }),
  ).toThrow('配置校验失败')
})

it('错误摘要保留状态与非 Error 原因，隐藏地址凭据且终止循环原因链', () => {
  const error = Object.assign(
    new Error('HTTP 403 https://user:password@example.invalid/file?token=secret'),
    {
      status: 403,
      code: 'AccessDenied',
    },
  )
  error.cause = error
  const reason = describeArchiveError(error)
  expect(reason).toContain('HTTP 403')
  expect(reason).toContain('status=403')
  expect(reason).toContain('AccessDenied')
  expect(reason).not.toContain('password')
  expect(reason).not.toContain('secret')
  expect(describeArchiveError('下载超时')).toBe('下载超时')
  expect(describeArchiveError({ message: 'token=secret Bearer private', code: 'EIO' })).toContain(
    'code=EIO',
  )
  expect(describeArchiveError({ message: 'token=secret Bearer private' })).not.toMatch(
    /secret|private/,
  )
})
