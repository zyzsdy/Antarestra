import ai from '@antarestra/ai'
import type { RunContext } from '@antarestra/ai'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import Storage from '@antarestra/storage'
import type { BlobUpload, StorageBackend } from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import type { FileAccess } from '@antarestra/plugin-workspace-file'
import { filePath } from '../../plugins/features/workspace-file/src/validation.js'
const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
class MemoryStorage implements StorageBackend {
  blobs = new Map<string, Uint8Array>()
  removed: string[] = []
  async begin(upload: BlobUpload) {
    return upload
  }
  async plan(upload: BlobUpload) {
    return {
      driver: 'memory',
      headers: {},
      parts: [{ number: 1, url: upload.stagingKey, offset: 0, size: upload.size }],
    }
  }
  async complete(upload: BlobUpload) {
    const data = this.blobs.get(upload.stagingKey)
    if (!data || data.length !== upload.size) throw new Error('大小不匹配')
    this.blobs.set(upload.key, data)
  }
  async discard(upload: BlobUpload) {
    await this.remove(upload.stagingKey)
  }
  async remove(key: string) {
    this.removed.push(key)
    this.blobs.delete(key)
  }
  async download(key: string) {
    return 'https://example.invalid/' + key
  }
  async read(key: string) {
    return this.blobs.get(key)!
  }
  async exists(key: string) {
    return this.blobs.has(key)
  }
}
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(WebUI)
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'storage-password-42',
  })
  const storage = await ctx.plugin(Storage)
  const backend = new MemoryStorage()
  const owner = await ctx.plugin({
    inject: ['storage'],
    apply(ctx: Context) {
      ctx.storage.register(ctx, 'test', backend)
    },
  })
  const fiber = await ctx.plugin(files, {
    backendId: 'test',
    defaultQuota: 20,
    maxFileSize: 20,
    uploadMinutes: 1,
  })
  let enabled = true
  ctx.rbac.registerRequestSource(ctx, 'test', {
    id: 'files-test',
    resolve: async (request) =>
      enabled
        ? {
            actorId: 'actor',
            workspaceId: String(request),
            roles: ['user'],
            workspaceLabel: `测试空间·${String(request)}`,
          }
        : undefined,
  })
  const a = await ctx.workspaceFile.authorize('test', 'a'),
    b = await ctx.workspaceFile.authorize('test', 'b')
  const base = `http://127.0.0.1:${ctx.server.address!.port}/api`
  const request = (path: string, cookie = '', body?: object, method = 'POST') =>
    fetch(base + path, {
      method: body ? method : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  async function upload(access: FileAccess, path: string, content = 'hello') {
    const ticket = await ctx.workspaceFile.begin(access, { path, size: Buffer.byteLength(content) })
    backend.blobs.set(ticket.plan.parts[0]!.url, Buffer.from(content))
    await ctx.workspaceFile.complete(access, ticket.token, [])
    return ticket
  }
  return {
    ctx,
    storage,
    fiber,
    owner,
    backend,
    a,
    b,
    request,
    upload,
    disable: () => {
      enabled = false
    },
  }
}
it('拒绝路径穿越，并且随机对象键不包含用户名称或目录', async () => {
  for (const path of ['../secret', '/a/../secret', '/a/./b', '/a\\b', '/a\0b'])
    expect(() => filePath(path)).toThrow()
  expect(filePath('/上传//截图.jpg')).toBe('/上传/截图.jpg')
  const app = await setup()
  const ticket = await app.upload(app.a, '/upload/2026-09-29/私人截图.jpg')
  expect(ticket.plan.parts[0]!.url).toMatch(/^uploads\/[a-f\d-]{36}$/)
  expect([...app.backend.blobs.keys()].some((key) => key.includes('私人'))).toBe(false)
  expect((await app.ctx.workspaceFile.list(app.a)).entries).toEqual([
    expect.objectContaining({ path: '/upload', kind: 'directory' }),
  ])
})
it('聊天附件使用稳定 ID、独立目录；移动后仍可访问，删除立即释放配额且不误删同名新文件', async () => {
  const app = await setup()
  const ticket = await app.ctx.workspaceFile.begin(app.a, {
    path: '截图.png',
    size: 5,
    attachment: true,
    mimeType: 'image/png',
  })
  app.backend.blobs.set(ticket.plan.parts[0]!.url, Buffer.from('hello'))
  const saved = await app.ctx.workspaceFile.complete(app.a, ticket.token, [])
  expect(saved.id).toBe(ticket.token)
  expect(saved.path).toMatch(/^\/chat-attachments\/[a-f\d-]+\/截图.png$/)
  expect(saved.url).toBe(`/api/workspace-files/resources/${ticket.token}/content`)
  expect((await app.ctx.workspaceFile.list(app.a)).used).toBe(5)
  await expect(app.ctx.workspaceFile.resource(app.b, saved.id)).rejects.toThrow('文件已过期')
  await app.ctx.workspaceFile.move(app.a, saved.path, '/new.png')
  expect((await app.ctx.workspaceFile.resource(app.a, saved.id)).path).toBe('/new.png')
  expect((await app.ctx.workspaceFile.readResource(app.a, saved.id)).bytes).toEqual(
    Buffer.from('hello'),
  )
  await app.ctx.workspaceFile.removeResource(app.a, saved.id)
  expect((await app.ctx.workspaceFile.list(app.a)).used).toBe(0)
  await expect(app.ctx.workspaceFile.resource(app.a, saved.id)).rejects.toThrow('文件已过期')
  const replacement = await app.upload(app.a, '/new.png')
  await app.ctx.workspaceFile.removeResource(app.a, saved.id)
  expect((await app.ctx.workspaceFile.resource(app.a, replacement.token)).size).toBe(5)
  const file = await app.ctx.workspaceFile.resource(app.a, replacement.token)
  const key = [...app.backend.blobs.keys()].find((key) => key.startsWith('objects/'))!
  app.backend.blobs.delete(key)
  await expect(app.ctx.workspaceFile.resource(app.a, file.id)).rejects.toThrow('文件已过期')
})
it('图片与文本允许内联，主动内容和未知类型下载，重命名保留上传类型', async () => {
  const app = await setup()
  const download = vi.spyOn(app.backend, 'download')
  for (const [path, contentType, disposition] of [
    ['/截图.PNG', 'image/png', 'inline'],
    ['/说明.txt', 'text/plain', 'inline'],
    ['/页面.html', 'text/html', 'attachment'],
    ['/矢量.svg', 'image/svg+xml', 'attachment'],
    ['/未知.unknown', 'application/octet-stream', 'attachment'],
  ]) {
    await app.upload(app.a, path!)
    await app.ctx.workspaceFile.download(app.a, path)
    expect(download).toHaveBeenLastCalledWith(expect.any(String), {
      contentType,
      contentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(path!.slice(1))}`,
    })
    await app.ctx.workspaceFile.remove(app.a, path)
  }
  await app.upload(app.a, '/original.html')
  await app.ctx.workspaceFile.move(app.a, '/original.html', '/renamed.png')
  await app.ctx.workspaceFile.download(app.a, '/renamed.png')
  expect(download).toHaveBeenLastCalledWith(expect.any(String), {
    contentType: 'text/html',
    contentDisposition: "attachment; filename*=UTF-8''renamed.png",
  })
})
it('配额预占抵御并发，取消释放预占，重复完成不重复计费', async () => {
  const app = await setup()
  const result = await Promise.allSettled([
    app.ctx.workspaceFile.begin(app.a, { path: '/one', size: 15 }),
    app.ctx.workspaceFile.begin(app.a, { path: '/two', size: 15 }),
  ])
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const ticket = result.find((r) => r.status === 'fulfilled')!
  if (ticket.status !== 'fulfilled') throw new Error('缺少上传')
  expect((await app.ctx.workspaceFile.list(app.a)).reserved).toBe(15)
  await app.ctx.workspaceFile.cancel(app.a, ticket.value.token)
  expect((await app.ctx.workspaceFile.list(app.a)).reserved).toBe(0)
  const finished = await app.upload(app.a, '/ok')
  await app.ctx.workspaceFile.complete(app.a, finished.token, [])
  expect((await app.ctx.workspaceFile.list(app.a)).used).toBe(5)
})
it('拒绝跨空间的令牌、文件下载、伪造授权与已撤销请求来源', async () => {
  const app = await setup()
  const ticket = await app.upload(app.a, '/secret')
  await expect(app.ctx.workspaceFile.complete(app.b, ticket.token, [])).rejects.toMatchObject({
    status: 404,
  })
  await expect(app.ctx.workspaceFile.download(app.b, '/secret')).rejects.toMatchObject({
    status: 404,
  })
  await expect(app.ctx.workspaceFile.list({ workspaceId: 'a' })).rejects.toMatchObject({
    status: 403,
  })
  app.disable()
  await expect(app.ctx.workspaceFile.read(app.a, '/secret')).rejects.toThrow()
})
it('服务端核验失败不产生文件；支持目录移动、空目录删除与垃圾回收', async () => {
  const app = await setup()
  const bad = await app.ctx.workspaceFile.begin(app.a, { path: '/bad', size: 3 })
  app.backend.blobs.set(bad.plan.parts[0]!.url, Buffer.from('wrong'))
  await expect(app.ctx.workspaceFile.complete(app.a, bad.token, [])).rejects.toThrow('大小不匹配')
  expect((await app.ctx.workspaceFile.list(app.a)).used).toBe(0)
  await app.ctx.workspaceFile.cancel(app.a, bad.token)
  await app.ctx.workspaceFile.mkdir(app.a, '/docs')
  await app.upload(app.a, '/docs/a.txt')
  await expect(app.ctx.workspaceFile.remove(app.a, '/docs')).rejects.toMatchObject({ status: 409 })
  await app.ctx.workspaceFile.move(app.a, '/docs', '/资料')
  expect(new TextDecoder().decode(await app.ctx.workspaceFile.read(app.a, '/资料/a.txt'))).toBe(
    'hello',
  )
  await app.ctx.workspaceFile.remove(app.a, '/资料/a.txt')
  await app.ctx.workspaceFile.remove(app.a, '/资料')
  await app.ctx.workspaceFile.sweep()
  expect(app.backend.removed.some((key) => key.startsWith('objects/'))).toBe(true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000)
  await app.ctx.workspaceFile.sweep()
  expect(app.backend.blobs.size).toBe(0)
})
it('过期上传不可完成，重载后仍保留目录和清理记录；卸载后旧服务不可用', async () => {
  const app = await setup()
  const old = app.ctx.workspaceFile
  const ticket = await app.upload(app.a, '/persistent')
  const pending = await app.ctx.workspaceFile.begin(app.a, { path: '/expires', size: 1 })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
  await expect(old.complete(app.a, pending.token, [])).rejects.toMatchObject({ status: 410 })
  await app.fiber.dispose()
  await expect(old.list(app.a)).rejects.toThrow()
  await app.ctx.plugin(files, { backendId: 'test', defaultQuota: 20 })
  const access = await app.ctx.workspaceFile.authorize('test', 'a')
  expect((await app.ctx.workspaceFile.list(access)).entries[0]?.path).toBe('/persistent')
  await app.owner.dispose()
  await expect(app.ctx.workspaceFile.download(access, '/persistent')).rejects.toThrow('尚未就绪')
  expect(ticket.token).toBeTruthy()
  await app.storage.dispose()
})
it('管理 API 显示中文空间来源、限制管理员、校验配额版本并拒绝客户端空间注入', async () => {
  const app = await setup()
  const login = await app.request('/auth/local/local/login', '', {
    email: 'admin@example.com',
    password: 'storage-password-42',
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const denied = await app.request('/workspace-file-admin')
  expect([401, 403]).toContain(denied.status)
  const response = await app.request('/workspace-file-admin', cookie)
  expect(response.status).toBe(200)
  const data = (await response.json()) as {
    entries: { id: string; label: string; revision: number }[]
  }
  const row = data.entries.find((row) => row.id.startsWith('personal:'))!
  expect(row.label).toContain('本地用户·')
  const body = { workspaceId: row.id, revision: row.revision, quota: 0 }
  expect((await app.request('/workspace-file-admin/quota', cookie, body, 'PUT')).status).toBe(200)
  expect((await app.request('/workspace-file-admin/quota', cookie, body, 'PUT')).status).toBe(409)
  expect((await app.request('/workspace-files?workspaceId=a', cookie)).status).toBe(403)
  expect(
    (
      await app.request('/workspace-files/uploads', cookie, {
        path: '/x',
        size: 1,
        workspaceId: 'a',
      })
    ).status,
  ).toBe(403)
  expect(
    (await app.request('/workspace-files/uploads', cookie, { path: '/x', size: 1 })).status,
  ).toBe(413)
})
it('Agent 文件工具只接受核心当前运行上下文，不能通过工具参数越过空间', async () => {
  const app = await setup()
  await app.upload(app.a, '/note.txt', 'hello')
  const photo = await app.upload(app.a, '/photo.png', 'hello')
  const attachment = await app.ctx.workspaceFile.resource(app.a, photo.token)
  await app.ctx.plugin(ai, {})
  const access = await app.ctx.ai.authorize('test', 'a')
  app.ctx.ai.registerBackend(app.ctx, {
    id: 'file-test',
    async run(runtime) {
      const forged = { ...runtime.context, workspaceId: 'b' }
      await expect(
        app.ctx.workspaceFile.authorize('workspace-file-agent', forged),
      ).rejects.toThrow()
      const output = await runtime.request()
      const calls = output.content.filter((block) => block.type === 'tool-call')
      if (!calls.length) return
      const result = await runtime.executeTools(calls)
      expect(JSON.stringify(result)).toContain('hello')
      await runtime.request()
    },
  })
  app.ctx.ai.registerProvider(app.ctx, {
    id: 'file-provider',
    title: '文件测试',
    baseUrl: 'https://example.invalid',
    driverId: 'file-driver',
    models: [
      {
        id: 'test',
        title: '测试模型',
        contextWindow: 10000,
        maxOutputTokens: 1000,
        input: ['text', 'image'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
    ],
  })
  app.ctx.ai.registerDriver(app.ctx, {
    id: 'file-driver',
    async generate(request, connection) {
      if (
        request.messages.some((message) => message.content.some((block) => block.type === 'image'))
      )
        expect(connection.resources?.get(photo.token)).toEqual({
          filename: 'photo.png',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        })
      return {
        content: request.messages.some((message) => message.role === 'tool')
          ? [{ type: 'text', text: '读取成功' }]
          : [
              {
                type: 'tool-call',
                id: 'file-call',
                name: 'workspace_file_read',
                arguments: { path: '/note.txt' },
              },
            ],
      }
    },
  })
  app.ctx.ai.registerAgent(app.ctx, {
    id: 'file-agent',
    title: '文件测试助理',
    version: '1',
    backendId: 'file-test',
    systemTemplate: '',
    userTemplate: '{{input}}',
    models: [{ providerId: 'file-provider', modelId: 'test' }],
    defaultModel: { providerId: 'file-provider', modelId: 'test' },
    toolIds: ['workspace_file_read', 'workspace_file_list'],
    skillIds: [],
    extensions: {},
  })
  const conversation = await app.ctx.ai.createConversation(access, 'file-agent')
  const run = await app.ctx.ai.start(access, conversation.id, {
    operation: 'send',
    input: {
      text: '读取文件',
      attachments: [
        {
          type: 'image',
          resourceId: photo.token,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          url: attachment.url,
        },
      ],
    },
    idempotencyKey: 'file-run',
    expectedRevision: conversation.revision,
    expectedNodeId: null,
  })
  for (let i = 0; i < 100; i++) {
    const record = await app.ctx.ai.getRun(access, run.id)
    if (record.status !== 'running') {
      expect(record.status, JSON.stringify(record.error)).toBe('completed')
      expect(JSON.stringify(record.requests)).not.toContain('aGVsbG8=')
      expect(record.input.attachments?.[0]?.resourceId).toBe(photo.token)
      break
    }
    await delay(10)
    if (i === 99) throw new Error('文件工具测试未结束')
  }
  await app.ctx.workspaceFile.removeResource(app.a, photo.token)
  const history = await app.ctx.ai.getConversation(access, conversation.id)
  const next = await app.ctx.ai.start(access, conversation.id, {
    operation: 'send',
    input: { text: '继续读取' },
    idempotencyKey: 'file-follow-up',
    expectedRevision: history.conversation.revision,
    expectedNodeId: history.conversation.selectedNodeId,
  })
  for (let i = 0; i < 100; i++) {
    const record = await app.ctx.ai.getRun(access, next.id)
    if (record.status !== 'running') {
      expect(record.status, JSON.stringify(record.error)).toBe('completed')
      expect(JSON.stringify(record.requests)).toContain('文件已过期')
      break
    }
    await delay(10)
    if (i === 99) throw new Error('附件历史测试未结束')
  }
  await expect(
    app.ctx.workspaceFile.authorize('workspace-file-agent', {
      runId: run.id,
      workspaceId: 'a',
      actorId: 'actor',
      signal: new AbortController().signal,
    } as RunContext),
  ).rejects.toThrow()
})
