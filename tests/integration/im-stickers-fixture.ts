import { randomUUID } from 'node:crypto'
import Storage, { type BlobUpload, type StorageBackend } from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import stickers from '@antarestra/plugin-im-stickers-lib'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import * as adminConsole from '@antarestra/plugin-admin-console'
import * as imConsole from '@antarestra/plugin-im-console'
import type { IncomingMessage, MessageSegment } from '@antarestra/im'
import type { ModelDriver } from '@antarestra/ai'
import { allowCommand, setup as setupIm } from './im-features-fixture.js'

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII=',
  'base64',
)
export class StickerStorage implements StorageBackend {
  blobs = new Map<string, Uint8Array>()
  failDelete = false
  base = ''
  async begin(upload: BlobUpload) {
    return upload
  }
  async plan(upload: BlobUpload) {
    return {
      driver: 'test',
      headers: {},
      parts: [{ number: 1, url: upload.stagingKey, offset: 0, size: upload.size }],
    }
  }
  async write(upload: BlobUpload, data: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted()
    this.blobs.set(upload.stagingKey, data)
    return []
  }
  async complete(upload: BlobUpload) {
    this.blobs.set(upload.key, this.blobs.get(upload.stagingKey)!)
  }
  async discard(upload: BlobUpload) {
    this.blobs.delete(upload.stagingKey)
  }
  async remove(key: string) {
    if (this.failDelete) throw new Error('模拟存储故障')
    this.blobs.delete(key)
  }
  async download(key: string) {
    return this.base + '/test-blobs/' + encodeURIComponent(key)
  }
  async temporaryUrl(key: string) {
    return { url: await this.download(key), expiresAt: Date.now() + 60_000 }
  }
  async read(key: string) {
    return this.blobs.get(key)!
  }
  async exists(key: string) {
    return this.blobs.has(key)
  }
}
export async function setupStickers(ai = false, driver?: ModelDriver) {
  const app = await setupIm({
    ai,
    systemTemplate: '表情包：\n{{ im_stickers }}',
    ...(driver ? { driver } : {}),
  })
  const { ctx } = app
  const web = await ctx.plugin(WebUI)
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'sticker-test-password',
  })
  await ctx.plugin(adminConsole)
  await ctx.plugin(imConsole)
  await ctx.plugin(Storage)
  const storage = new StickerStorage()
  ctx.storage.register(ctx, 'test', storage)
  const filePlugin = await ctx.plugin(files, { backendId: 'test', defaultQuota: 32 * 1024 ** 2 })
  const plugin = await ctx.plugin(stickers)
  await allowCommand(ctx, 'sticker')
  const base = `http://127.0.0.1:${ctx.server.address!.port}`
  storage.base = base + '/api'
  ctx.server.route(ctx, 'GET', '/test-blobs/:key', (http) => {
    http.type = 'image/png'
    http.body = Buffer.from(storage.blobs.get(String(http.params.key)) ?? [])
  })
  const owners = new Map([
    ['g1', 'owner'],
    ['g2', 'other-owner'],
  ])
  const sent: (readonly MessageSegment[])[] = []
  const connection = ctx.im.registerConnection(ctx, {
    id: 'stickers-test',
    platform: 'qq',
    accountId: 'bot',
    getMember: async (target, id) => ({
      active: true,
      role: owners.get(target.id) === id ? 'owner' : id === 'platform-admin' ? 'admin' : 'member',
    }),
    downloadMedia: async () => ({ data: png, mimeType: 'image/png', filename: 'test.png' }),
    send: async (_target, segments) => {
      sent.push(segments)
      return { messageId: randomUUID() }
    },
  })
  await ctx.im.setPolicy('stickers-test', {
    group: { mode: 'whitelist', ids: ['g1', 'g2'] },
    private: { mode: 'whitelist', ids: ['owner'] },
  })
  connection.setStatus('online')
  const receive = (
    text: string,
    user = 'owner',
    group = 'g1',
    extra: MessageSegment[] = [],
    changes: Partial<IncomingMessage> = {},
  ) =>
    connection.receive({
      id: randomUUID(),
      chat: { type: 'group', id: group },
      sender: { id: user },
      segments: [{ type: 'text', text }, ...extra],
      ...changes,
    })
  await receive('初始化群一')
  await receive('初始化群二', 'member', 'g2')
  const groups = (await ctx.im.listGroups(0, 20)).groups
  const workspace = (group: string) => groups.find((item) => item.chatId === group)!.workspaceId
  const request = (path: string, cookie = '', body?: object, method = 'POST', origin?: string) =>
    fetch(base + '/api' + path, {
      method: body ? method : 'GET',
      redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = await request('/auth/local/local/login', '', {
    email: 'admin@example.com',
    password: 'sticker-test-password',
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  return {
    ...app,
    web,
    filePlugin,
    plugin,
    storage,
    base,
    cookie,
    request,
    receive,
    sent,
    owners,
    workspace,
  }
}
