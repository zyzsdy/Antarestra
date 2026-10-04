import { afterEach, expect, it, vi } from 'vitest'
import stickers from '@antarestra/plugin-im-stickers-lib'
import commands from '@antarestra/plugin-im-commands'
import { cleanup } from './im-features-fixture.js'
import { png, setupStickers } from './im-stickers-fixture.js'

afterEach(cleanup)
const image = { data: png, mimeType: 'image/png' }
const upload = {
  title: '开心',
  description: '开心地笑',
  category: '情绪',
  data: png.toString('base64'),
  mimeType: 'image/png',
}

it('全局表情包 CRUD 校验权限、图片内容、同名标题、修订号和跨站请求', async () => {
  const app = await setupStickers()
  const { request, cookie } = app
  expect((await request('/im-stickers')).status).toBe(401)
  expect(
    (await request('/im-stickers', cookie, upload, 'POST', 'https://untrusted.invalid')).status,
  ).toBe(403)
  expect(
    (
      await request('/im-stickers', cookie, {
        ...upload,
        data: Buffer.from('invalid').toString('base64'),
      })
    ).status,
  ).toBe(400)
  const added = await request('/im-stickers', cookie, upload)
  expect(added.status).toBe(200)
  const row = await added.json()
  expect(row).toMatchObject({
    title: '开心',
    description: '开心地笑',
    category: '情绪',
    revision: 0,
  })
  expect((await request('/im-stickers', cookie, upload)).status).toBe(409)
  expect((await request(`/im-stickers/${row.id}/content`, cookie)).status).toBe(302)
  expect(
    (
      await request(
        `/im-stickers/${row.id}`,
        cookie,
        { title: '新的标题', description: '新描述', category: '反应', revision: 0 },
        'PUT',
      )
    ).status,
  ).toBe(200)
  expect(
    (await request(`/im-stickers/${row.id}`, cookie, { title: '旧修改', revision: 0 }, 'PUT'))
      .status,
  ).toBe(409)
  expect((await request(`/im-stickers/${row.id}/delete`, cookie, { revision: 0 })).status).toBe(409)
  expect((await request(`/im-stickers/${row.id}/delete`, cookie, { revision: 1 })).status).toBe(200)
  expect(await (await request('/im-stickers', cookie)).json()).toEqual({ stickers: [] })
  await request('/auth/local/local/register', '', {
    email: 'user@example.com',
    displayName: '普通用户',
    password: 'sticker-test-password',
  })
  const login = await request('/auth/local/local/login', '', {
    email: 'user@example.com',
    password: 'sticker-test-password',
  })
  const userCookie = login.headers.get('set-cookie')!.split(';')[0]!
  expect((await request('/im-stickers', userCookie)).status).toBe(403)
})

it('共享 ID 可在不同空间读取和准备发送，原有私有文件与写入仍隔离，撤销共享立即生效', async () => {
  const { ctx, plugin } = await setupStickers()
  ctx.rbac.registerRequestSource(ctx, 'sticker-test', {
    id: 'sticker-test',
    resolve: async (request) => ({
      actorId: 'actor',
      workspaceId: String(request),
      roles: ['user'],
    }),
  })
  const a = await ctx.workspaceFile.authorize('sticker-test', 'a')
  const b = await ctx.workspaceFile.authorize('sticker-test', 'b')
  const privateFile = await ctx.workspaceFile.writeAttachment(
    a,
    { ...image, filename: 'private.png' },
    new AbortController().signal,
  )
  await expect(ctx.workspaceFile.resource(b, privateFile.id)).rejects.toMatchObject({ status: 410 })
  const row = await ctx.imStickers.run((signal) =>
    ctx.imStickers.add({ title: '全局' }, image, signal),
  )
  expect(await ctx.workspaceFile.readResource(b, row.id)).toMatchObject({ id: row.id, bytes: png })
  expect(await ctx.workspaceFile.prepareImage(b, { resourceId: row.id })).toMatchObject({
    resourceId: row.id,
    src: `resource://${row.id}`,
  })
  expect(await ctx.workspaceFile.temporaryUrl(b, row.id)).toMatchObject({
    url: expect.stringContaining('/test-blobs/'),
  })
  await ctx.workspaceFile.removeResource(b, row.id)
  expect(await ctx.workspaceFile.resource(a, row.id)).toMatchObject({ id: row.id })
  expect((await ctx.workspaceFile.list(b)).entries).toHaveLength(0)
  await plugin.dispose()
  await expect(ctx.workspaceFile.resource(a, row.id)).rejects.toMatchObject({ status: 410 })
  const replacement = await ctx.plugin(stickers)
  expect(await ctx.workspaceFile.resource(a, row.id)).toMatchObject({ id: row.id })
  await ctx.imStickers.remove(row.id, 0)
  await expect(ctx.workspaceFile.resource(a, row.id)).rejects.toMatchObject({ status: 410 })
  await replacement.dispose()
})

it('表情包添加、删除只对当前群 bot 管理员开放，图片独立于媒体归档并支持带空格标题', async () => {
  const { ctx, receive, sent, workspace } = await setupStickers()
  await receive('/sticker add 测试', 'member', 'g1', [{ type: 'image', url: 'test://image' }])
  expect(JSON.stringify(sent.at(-1))).toContain('仅当前群')
  await receive('/sticker add 开 心', 'owner', 'g1', [{ type: 'image', url: 'test://image' }])
  const row = (await ctx.imStickers.list())[0]!
  expect(row).toMatchObject({ title: '开 心', description: '', category: '未分类' })
  await ctx.workspaceFile.retainGroupArchive(ctx, workspace('g1'), 0, 1)
  expect(await ctx.imStickers.content(row.id)).toContain('/test-blobs/')
  await receive('/sticker add 缺图')
  expect(JSON.stringify(sent.at(-1))).toContain('附带一张图片')
  await receive('/sticker delete 开 心', 'owner', 'g2')
  expect(await ctx.imStickers.list()).toHaveLength(1)
  await receive('/sticker delete "开 心"')
  expect(await ctx.imStickers.list()).toHaveLength(0)
})

it('群主自动授权、平台管理员不自动授权，管理员按群持久化且群主转移立即生效', async () => {
  const { ctx, commandPlugin, receive, sent, owners, workspace } = await setupStickers()
  await receive('/admin add delegate', 'platform-admin')
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toEqual([])
  await receive('/admin add delegate')
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toEqual(['delegate'])
  await receive('/admin add another', 'delegate')
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toEqual(['delegate', 'another'])
  await receive('/admin add intruder', 'delegate', 'g2')
  expect((await ctx.imCommands.admins.get(workspace('g2'))).users).toEqual([])
  await commandPlugin.dispose()
  await ctx.plugin(commands)
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toContain('delegate')
  owners.set('g1', 'new-owner')
  await receive('/admin add obsolete', 'owner')
  expect(JSON.stringify(sent.at(-1))).toContain('仅当前群')
  await receive('/admin add current', 'new-owner')
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toContain('current')
  await receive('/help', 'member')
  expect(JSON.stringify(sent.at(-1))).toContain('/ping')
  expect(JSON.stringify(sent.at(-1))).not.toContain('/sticker')
  await receive('/admin add nobody', 'new-owner', 'g1', [], {
    chat: { type: 'private', id: 'owner' },
  })
  expect(JSON.stringify(sent.at(-1))).toContain('仅可在群聊')
})

it('控制台按群设置管理员并检查权限、私聊范围、修订冲突与并发添加', async () => {
  const { ctx, request, cookie, workspace, receive } = await setupStickers()
  const path = `/im/groups/${encodeURIComponent(workspace('g1'))}/admins`
  expect((await request(path)).status).toBe(401)
  expect(await (await request(path, cookie)).json()).toEqual({ users: [], revision: 0 })
  expect((await request(path, cookie, { users: ['delegate'], revision: 0 }, 'PUT')).status).toBe(
    200,
  )
  expect((await request(path, cookie, { users: [], revision: 0 }, 'PUT')).status).toBe(409)
  expect((await request('/im/groups/nonexistent/admins', cookie)).status).toBe(404)
  await Promise.all([
    receive('/admin add user-a', 'delegate'),
    receive('/admin add user-b', 'delegate'),
  ])
  expect((await ctx.imCommands.admins.get(workspace('g1'))).users).toEqual(
    expect.arrayContaining(['delegate', 'user-a', 'user-b']),
  )
  expect((await ctx.imCommands.admins.get(workspace('g2'))).users).toEqual([])
})

it('删除存储故障时先撤销共享并持久重试，重复标题竞争不会发布孤立图片', async () => {
  const { ctx, storage } = await setupStickers()
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      ctx.imStickers.run((signal) => ctx.imStickers.add({ title: '并发' }, image, signal)),
    ),
  )
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  const row = (await ctx.imStickers.list())[0]!
  storage.failDelete = true
  await ctx.imStickers.remove(row.id, 0)
  expect(await ctx.imStickers.list()).toEqual([])
  await expect(ctx.imStickers.content(row.id)).rejects.toMatchObject({ status: 404 })
  storage.failDelete = false
  await ctx.imStickers.collect()
  await ctx.workspaceFile.sweep()
  expect([...storage.blobs.keys()].filter((key) => !key.startsWith('uploads/'))).toHaveLength(0)
})

it('模板一行一条、包含四个字段，卸载 WebUI 不撤销共享库，插件卸载回收模板', async () => {
  const { ctx, web, plugin } = await setupStickers(true)
  expect(await ctx.imStickers.template()).toBe('')
  const row = await ctx.imStickers.run((signal) =>
    ctx.imStickers.add(
      { title: '笑脸', description: '开心 | 很开心', category: '反应' },
      image,
      signal,
    ),
  )
  expect(await ctx.imStickers.template()).toBe(
    `ID: ${row.id} | 标题: "笑脸" | 文本描述: "开心 | 很开心" | 分类: "反应"`,
  )
  expect(ctx.ai.listTemplateVariables().some((item) => item.id === 'im_stickers')).toBe(true)
  await web.dispose()
  expect(await ctx.imStickers.list()).toHaveLength(1)
  await plugin.dispose()
  expect(ctx.ai.listTemplateVariables().some((item) => item.id === 'im_stickers')).toBe(false)
})

it('真实 Agent 运行展开表情包模板，并由现有 IM 图片解析链发送共享文件 ID', async () => {
  let resourceId = '',
    prompt = ''
  const app = await setupStickers(true, {
    id: 'driver',
    async generate(request) {
      prompt = JSON.stringify(request)
      return { content: [{ type: 'text', text: `<sticker>resource://${resourceId}</sticker>` }] }
    },
  })
  const row = await app.ctx.imStickers.run((signal) =>
    app.ctx.imStickers.add({ title: '全局笑脸' }, image, signal),
  )
  resourceId = row.id
  await app.connection.receive('/ai 发个表情')
  await expect.poll(async () => (await app.jobs())[0]?.delivery, { timeout: 5000 }).toBe('sent')
  expect(prompt).toContain(row.id)
  expect(prompt).toContain('全局笑脸')
  expect(prompt).not.toContain('{{ im_stickers }}')
  const jobs = await app.jobs()
  expect(jobs[0]?.answer).toContain(row.id)
})

it('卸载取消并等待在途图片上传，重新加载后不保留未发布表情包', async () => {
  const { ctx, plugin, storage } = await setupStickers()
  let started = false,
    cancelled = false
  vi.spyOn(storage, 'write').mockImplementation(async (_upload, _data, signal) => {
    started = true
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true
          resolve()
        },
        { once: true },
      ),
    )
    signal.throwIfAborted()
    return []
  })
  const work = ctx.imStickers.run((signal) =>
    ctx.imStickers.add({ title: '未完成' }, image, signal),
  )
  const result = work.catch((error: unknown) => error)
  await expect.poll(() => started).toBe(true)
  await plugin.dispose()
  expect(cancelled).toBe(true)
  expect(await result).toBeInstanceOf(Error)
  await ctx.plugin(stickers)
  expect(await ctx.imStickers.list()).toEqual([])
})

it('命令服务卸载时控制台仍可查看群历史，管理员操作明确返回不可用', async () => {
  const { commandPlugin, request, cookie, workspace } = await setupStickers()
  await commandPlugin.dispose()
  expect(
    (await request(`/im/groups/${encodeURIComponent(workspace('g1'))}/admins`, cookie)).status,
  ).toBe(503)
  expect((await request('/im/groups', cookie)).status).toBe(200)
})
