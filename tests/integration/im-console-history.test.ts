import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import * as consolePlugin from '@antarestra/plugin-im-console'
import imAi from '@antarestra/plugin-im-ai'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)

async function appFixture(databaseFilename?: string) {
  const app = await setup({ ai: true, ...(databaseFilename ? { databaseFilename } : {}) })
  const { ctx } = app
  await ctx.plugin(WebUI)
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'history-test-42',
  })
  const consoleFiber = await ctx.plugin(consolePlugin)
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
  const login = await request('/auth/local/local/login', '', {
    email: 'admin@example.com',
    password: 'history-test-42',
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  return { ...app, request, cookie, consoleFiber }
}

it('群历史管理独立鉴权，消息游标不遗漏，隔离其他群与私聊空间', async () => {
  const app = await appFixture()
  const { request, cookie, ctx } = app
  expect((await request('/im/groups')).status).toBe(401)
  await request('/auth/local/local/register', '', {
    email: 'user@example.com',
    password: 'history-test-42',
    displayName: '普通用户',
  })
  const login = await request('/auth/local/local/login', '', {
    email: 'user@example.com',
    password: 'history-test-42',
  })
  const userCookie = login.headers.get('set-cookie')!.split(';')[0]!
  expect((await request('/im/groups', userCookie)).status).toBe(403)
  for (let index = 0; index < 53; index++)
    await app.connection.receive(`归档消息 ${index}`, {
      id: `message-${index}`,
      chatName: '测试群',
      raw: { platformOnly: true },
    })
  const group = app.messages[0]!.workspaceId
  const other = await app.connect('other', '06')
  await other.receive('其他机器人的同名群')
  const otherGroup = app.messages.at(-1)!.workspaceId
  const privateChat = await app.connect('private', '07', {
    private: { mode: 'blacklist', ids: [] },
  })
  await privateChat.receive('私聊', { chat: { type: 'private', id: 'user' } })
  const privateGroup = app.messages.at(-1)!.workspaceId
  const listing = await request('/im/groups', cookie)
  expect(listing.headers.get('cache-control')).toBe('no-store')
  expect(await listing.json()).toMatchObject({
    total: 2,
    groups: expect.arrayContaining([
      {
        workspaceId: group,
        connectionId: 'qq-a',
        platform: 'qq',
        chatId: '40894918',
        name: '测试群',
        archived: false,
        connected: true,
        lastMessageAt: expect.any(Number),
      },
    ]),
  })
  const first = await (await request(`/im/groups/${group}/messages`, cookie)).json()
  expect(first.messages).toHaveLength(50)
  expect(first.messages[0].message.id).toBe('message-3')
  expect(JSON.stringify(first)).not.toContain('platformOnly')
  expect(JSON.stringify(first)).not.toContain('其他机器人的同名群')
  const older = await (
    await request(`/im/groups/${group}/messages?before=${first.nextBefore}`, cookie)
  ).json()
  expect(older.messages.map((item: { message: { id: string } }) => item.message.id)).toEqual([
    'message-0',
    'message-1',
    'message-2',
  ])
  expect(older.nextBefore).toBeNull()
  const search = await (
    await request(`/im/groups/${group}/messages?keyword=${encodeURIComponent('消息 52')}`, cookie)
  ).json()
  expect(search.messages).toHaveLength(1)
  for (const path of [`/im/groups/${privateGroup}/messages`, '/im/groups/foreign/messages'])
    expect((await request(path, cookie)).status).toBe(404)
  expect((await request(`/im/groups/${otherGroup}/messages`, userCookie)).status).toBe(403)
  for (const query of ['before=-1', 'before=abc', 'before=1.5'])
    expect((await request(`/im/groups/${group}/messages?${query}`, cookie)).status).toBe(400)
  expect((await request('/im/groups?offset=NaN', cookie)).status).toBe(400)
  expect(await ctx.im.history(group)).toHaveLength(50)
  const { auth } = await (await request('/auth/me', userCookie)).json()
  expect(
    (
      await request(
        '/rbac/roles/history-reader',
        cookie,
        {
          name: '群历史只读',
          permissions: ['admin.console.view', 'admin.im.history.view'],
        },
        'PUT',
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await request(
        `/rbac/bindings/${auth.principalId}`,
        cookie,
        {
          roleId: 'history-reader',
          scope: 'system',
          enabled: true,
        },
        'PUT',
      )
    ).status,
  ).toBe(200)
  expect((await request(`/im/groups/${group}/messages`, userCookie)).status).toBe(200)
  expect((await request('/im/connections/qq-a/policy', userCookie)).status).toBe(403)
  expect(
    (await request(`/im/groups/${group}/archive`, userCookie, { archived: true }, 'PUT')).status,
  ).toBe(403)
  expect((await request(`/im/groups/${group}`, userCookie, {}, 'DELETE')).status).toBe(403)
  await app.consoleFiber.dispose()
  expect((await request('/im/groups', cookie)).status).toBe(404)
})

it('从群读取实际 AI 请求与返回，保留 reset 前会话，防止跨群读取并回收历史扩展', async () => {
  const app = await appFixture()
  const { request, cookie, ctx } = app
  await app.connection.receive('/ai 第一轮', { chatName: '不会被机器人回复覆盖的群名' })
  await expect.poll(() => app.sent.length, { timeout: 5000 }).toBe(1)
  const group = app.messages[0]!.workspaceId
  const firstJob = (await app.jobs())[0]!
  expect((await ctx.im.listGroups()).groups[0]?.name).toBe('不会被机器人回复覆盖的群名')
  const listing = await (await request(`/im/groups/${group}/ai`, cookie)).json()
  expect(listing).toMatchObject({
    available: true,
    total: 1,
    currentConversationId: firstJob.conversation_id,
    entries: [
      { inputPreview: `${firstJob.input.slice(0, 120)}…`, status: 'completed', delivery: 'sent' },
    ],
  })
  const detailResponse = await request(`/im/groups/${group}/ai/${firstJob.id}`, cookie)
  expect(detailResponse.status).toBe(200)
  const detail = await detailResponse.json()
  expect(detail).toMatchObject({
    input: firstJob.input,
    answer: firstJob.answer,
    run: { model: { modelId: 'model' }, requests: [{ systemPrompt: '系统' }] },
  })
  expect(detail.run.messages.some((item: { role: string }) => item.role === 'assistant')).toBe(true)
  const other = await app.connect('other', '06')
  await other.receive('其他群')
  const otherGroup = app.messages.at(-1)!.workspaceId
  expect((await request(`/im/groups/${otherGroup}/ai/${firstJob.id}`, cookie)).status).toBe(404)
  await expect(ctx.ai.inspectRun(otherGroup, firstJob.run_id!)).rejects.toMatchObject({
    status: 404,
  })
  await app.connection.receive('/reset')
  await app.connection.receive('/ai 新会话')
  await expect
    .poll(async () => (await app.jobs()).filter((job) => job.status === 'completed').length, {
      timeout: 5000,
    })
    .toBe(2)
  const afterReset = await (await request(`/im/groups/${group}/ai`, cookie)).json()
  expect(afterReset.total).toBe(2)
  expect(afterReset.currentConversationId).not.toBe(firstJob.conversation_id)
  expect((await request(`/im/groups/${group}/ai/${firstJob.id}`, cookie)).status).toBe(200)
  await app.aiPlugin!.dispose()
  expect(ctx.im.aiHistory).toBeUndefined()
  expect(await (await request(`/im/groups/${group}/ai`, cookie)).json()).toMatchObject({
    available: false,
  })
  expect((await request(`/im/groups/${group}/ai/${firstJob.id}`, cookie)).status).toBe(503)
  await ctx.plugin(imAi, { pollIntervalMs: 20 })
  expect((await request(`/im/groups/${group}/ai/${firstJob.id}`, cookie)).status).toBe(200)
})

it('归档与取消归档持久保存，接入规则变化显示停用状态，管理权限独立校验', async () => {
  const { ctx, connection, request, cookie } = await appFixture()
  await connection.receive('保留历史')
  const group = (await ctx.im.listGroups()).groups[0]!
  const path = `/im/groups/${group.workspaceId}/archive`
  expect((await request(path, '', { archived: true }, 'PUT')).status).toBe(401)
  expect((await request(path, cookie, { archived: 'true' }, 'PUT')).status).toBe(400)
  expect(
    (await request('/im/groups/foreign/archive', cookie, { archived: true }, 'PUT')).status,
  ).toBe(404)
  expect((await request(path, cookie, { archived: true }, 'PUT')).status).toBe(200)
  expect((await ctx.im.listGroups()).total).toBe(0)
  expect(await (await request('/im/groups?archived=true', cookie)).json()).toMatchObject({
    total: 1,
    groups: [{ archived: true, connected: true }],
  })
  await connection.receive('归档后仍可接收消息')
  expect((await ctx.im.listGroups()).total).toBe(0)
  expect(await ctx.im.history(group.workspaceId)).toHaveLength(2)
  await ctx.im.setPolicy('qq-a', { group: { mode: 'whitelist', ids: [] } })
  expect((await ctx.im.listGroups(0, 20, true)).groups[0]?.connected).toBe(false)
  expect((await request(path, cookie, { archived: false }, 'PUT')).status).toBe(200)
  expect((await ctx.im.listGroups()).groups[0]).toMatchObject({ archived: false, connected: false })
  expect((await request('/im/groups?archived=invalid', cookie)).status).toBe(400)
})

it('永久删除仅允许已归档群，事务清除消息及 AI 历史并隔离其他群', async () => {
  const app = await appFixture()
  const { ctx, cookie, request } = app
  await app.connection.receive('/ai 待删除的会话')
  await expect.poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  const job = (await app.jobs())[0]!
  const group = job.workspace_id
  const other = await app.connect('other', '06')
  await other.receive('/ai 保留的会话')
  await expect
    .poll(async () => (await app.jobs()).filter((row) => row.delivery === 'sent').length)
    .toBe(2)
  const otherJob = (await app.jobs()).find((row) => row.workspace_id !== group)!
  const path = `/im/groups/${group}`
  expect((await request(path, '', {}, 'DELETE')).status).toBe(401)
  expect((await request(path, cookie, {}, 'DELETE')).status).toBe(409)
  expect((await request('/im/groups/foreign', cookie, {}, 'DELETE')).status).toBe(404)
  await ctx.im.archiveGroup(group, true)
  // 任一参与方失败时，AI 与 IM 的历史必须一起回滚。
  await expect(
    ctx.im.aiHistory!.remove!(group, async () => {
      throw new Error('模拟事务失败')
    }),
  ).rejects.toThrow('模拟事务失败')
  expect((await ctx.im.aiHistory!.list(group, 0, 20)).total).toBe(1)
  expect(await ctx.ai.inspectRun(group, job.run_id!)).toMatchObject({ id: job.run_id })
  expect((await request(path, cookie, {}, 'DELETE')).status).toBe(200)
  expect((await request(`${path}/messages`, cookie)).status).toBe(404)
  expect((await request(`${path}/ai`, cookie)).status).toBe(404)
  expect(await ctx.im.history(group)).toHaveLength(0)
  expect((await ctx.im.aiHistory!.list(group, 0, 20)).total).toBe(0)
  await expect(ctx.ai.inspectRun(group, job.run_id!)).rejects.toMatchObject({ status: 404 })
  expect(await ctx.ai.inspectRun(otherJob.workspace_id, otherJob.run_id!)).toMatchObject({
    id: otherJob.run_id,
  })
  expect((await ctx.im.listGroups()).total).toBe(1)
  expect((await request(path, cookie, {}, 'DELETE')).status).toBe(404)
  await app.connection.receive('删除后的新消息')
  expect((await ctx.im.listGroups()).total).toBe(2)
  expect(await ctx.im.history(group)).toHaveLength(1)
  expect((await ctx.im.aiHistory!.list(group, 0, 20)).total).toBe(0)
})

it('AI 历史服务缺失或任务未结束时拒绝删除，保留已归档群和消息', async () => {
  const app = await appFixture()
  const { ctx, cookie, request } = app
  await app.connection.receive('待归档历史')
  const group = app.messages[0]!.workspaceId
  await ctx.im.archiveGroup(group, true)
  await app.aiPlugin!.dispose()
  expect((await request(`/im/groups/${group}`, cookie, {}, 'DELETE')).status).toBe(503)
  expect((await ctx.im.listGroups(0, 20, true)).total).toBe(1)
  expect(await ctx.im.history(group)).toHaveLength(1)
  await ctx.plugin(imAi, { pollIntervalMs: 20 })
  app.connection.handle.setStatus('offline')
  await app.connection.receive('/ai 排队的任务')
  expect((await request(`/im/groups/${group}`, cookie, {}, 'DELETE')).status).toBe(409)
  expect((await ctx.im.listGroups(0, 20, true)).total).toBe(1)
  expect(await ctx.im.history(group)).toHaveLength(2)
})

it('磁盘数据库重启后保留群归档状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-im-archive-'))
  try {
    const filename = join(directory, 'history.sqlite')
    const first = await appFixture(filename)
    await first.connection.receive('重启后仍隐藏')
    const group = first.messages[0]!.workspaceId
    await first.ctx.im.archiveGroup(group, true)
    await cleanup()
    const second = await appFixture(filename)
    expect((await second.ctx.im.listGroups()).total).toBe(0)
    expect((await second.ctx.im.listGroups(0, 20, true)).groups[0]?.workspaceId).toBe(group)
    await second.ctx.im.archiveGroup(group, false)
    expect((await second.ctx.im.listGroups()).total).toBe(1)
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
