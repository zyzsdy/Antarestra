import { afterEach, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import im, { type MessageContext, type IncomingMessage } from '@antarestra/im'
import identityIm from '@antarestra/plugin-identity-im'
import Storage from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import type { Tables as RbacTables } from '../../plugins/definitions/rbac/src/schema.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const policy = {
  private: { mode: 'whitelist' as const, ids: ['fish'] },
  group: { mode: 'whitelist' as const, ids: ['40894918', 'other'] },
}
const message = (id = '1', sender = 'fish', chat = '40894918'): IncomingMessage => ({
  id,
  chat: { type: 'group', id: chat },
  sender: { id: sender },
  segments: [{ type: 'text', text: '测试' }],
})
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(im)
  const identityFiber = await ctx.plugin(identityIm)
  ctx.rbac.registerPermission(ctx, 'test.im.use', 'IM 测试', ['user'])
  const received: MessageContext[] = []
  ctx.im.registerHandler(ctx, {
    id: 'capture',
    stage: 'message',
    handle: (context) => {
      received.push(context)
    },
  })
  let memberActive = true
  const register = async (id: string, accountId: string) => {
    const handle = ctx.im.registerConnection(ctx, {
      id,
      platform: 'qq',
      accountId,
      send: async () => ({}),
      getMember: async () => ({ active: memberActive }),
    })
    await ctx.im.setPolicy(id, policy)
    return handle
  }
  return {
    ctx,
    received,
    register,
    identityFiber,
    setMemberActive: (active: boolean) => {
      memberActive = active
    },
  }
}

it('真实数据库映射维持双账号隔离、同群共享空间、普通用户权限且不签发本地会话', async () => {
  const { ctx, received, register } = await setup(),
    a = await register('a', '05'),
    b = await register('b', '06')
  await a.receive(message())
  await a.receive(message('2', 'bird'))
  await b.receive(message())
  await a.receive({ ...message('3'), chat: { type: 'private', id: 'fish' } })
  expect(received[0]!.workspaceId).toBe(received[1]!.workspaceId)
  expect(received[0]!.actorId).not.toBe(received[1]!.actorId)
  expect(received[0]!.workspaceId).not.toBe(received[2]!.workspaceId)
  expect(received[0]!.actorId).not.toBe(received[2]!.actorId)
  expect(received[0]!.workspaceId).not.toBe(received[3]!.workspaceId)
  for (const context of received)
    expect(await ctx.rbac.authorizeRequest('im', context.request, 'test.im.use')).toMatchObject({
      actorId: context.actorId,
      workspaceId: context.workspaceId,
      roles: ['user'],
    })
  expect(
    await ctx.database
      .scope<RbacTables>(ctx, '@antarestra/rbac')
      .selectFrom('session')
      .selectAll()
      .execute(),
  ).toEqual([])
  await expect(
    ctx.rbac.authorizeRequest('im', { ...received[0], roles: ['admin'] }, 'test.im.use'),
  ).rejects.toThrow('请先登录')
})

it('撤销成员、禁用空间、平台成员离开及卸载身份源使请求和后台任务失效', async () => {
  const { ctx, received, register, identityFiber, setMemberActive } = await setup(),
    a = await register('a', '05')
  a.setStatus('online')
  await a.receive(message())
  const context = received[0]!
  const background = () =>
    ctx.rbac.authorizeBackground('im', context.actorId, context.workspaceId, 'test.im.use')
  await expect(background()).resolves.toMatchObject({ roles: ['user'] })
  setMemberActive(false)
  await expect(background()).rejects.toThrow('账号或空间不可用')
  setMemberActive(true)
  await ctx.identityIm.setMemberActive(context.actorId, context.workspaceId, false)
  expect(await ctx.im.authenticate(context.request)).toBeUndefined()
  await expect(background()).rejects.toThrow('账号或空间不可用')
  await a.receive(message('2'))
  expect(received).toHaveLength(1)
  await ctx.identityIm.setMemberActive(context.actorId, context.workspaceId, true)
  await ctx.identityIm.setWorkspaceActive(context.workspaceId, false)
  expect(await ctx.im.authenticate(context.request)).toBeUndefined()
  await ctx.identityIm.setWorkspaceActive(context.workspaceId, true)
  await identityFiber.dispose()
  expect(await ctx.im.authenticate(context.request)).toBeUndefined()
  await expect(background()).rejects.toThrow('通道不可用')
})

it('映射在身份插件重装后保留，停用主体不会因再次收到消息复活', async () => {
  const { ctx, received, register, identityFiber } = await setup(),
    a = await register('a', '05')
  await a.receive(message())
  const first = received[0]!
  await identityFiber.dispose()
  await ctx.plugin(identityIm)
  await a.receive(message('2'))
  expect(received[1]!.actorId).toBe(first.actorId)
  expect(received[1]!.workspaceId).toBe(first.workspaceId)
  await ctx.database
    .scope<RbacTables>(ctx, '@antarestra/rbac')
    .updateTable('principal')
    .set({ status: 'disabled' })
    .where('id', '=', first.actorId)
    .execute()
  await a.receive(message('3'))
  expect(received).toHaveLength(2)
  expect(await ctx.im.authenticate(received[1]!.request)).toBeUndefined()
})

it('已有群聊和私聊在首次文件授权前进入管理目录，禁用与重载保留空间和配额', async () => {
  const { ctx, received, register, identityFiber } = await setup()
  const connection = await register('a', '05')
  await connection.receive(message())
  await connection.receive({ ...message('2'), chat: { type: 'private', id: 'fish' } })
  // 模拟升级前只有 IM 私有映射，插件重载时将既有空间迁入统一目录。
  await ctx.database.scope<RbacTables>(ctx, '@antarestra/rbac').deleteFrom('workspace').execute()
  await identityFiber.dispose()
  const reloaded = await ctx.plugin(identityIm)
  // 映射先建立，文件插件后加载，不依赖文件访问触发目录登记。
  await ctx.plugin(Storage)
  await ctx.plugin(files, { defaultQuota: 100 })
  const initial = await ctx.workspaceFile.spaces(1, '')
  expect(initial.total).toBe(2)
  expect(initial.entries.map((row) => row.id).sort()).toEqual(
    received.map((row) => row.workspaceId).sort(),
  )
  expect(initial.entries.map((row) => row.label)).toEqual(
    expect.arrayContaining(['qq·群聊·40894918', 'qq·私聊·fish']),
  )
  const group = initial.entries.find((row) => row.id === received[0]!.workspaceId)!
  await ctx.workspaceFile.quota(group.id, 50, group.revision)
  await ctx.identityIm.setWorkspaceActive(group.id, false)
  await expect(ctx.workspaceFile.authorize('im', received[0]!.request)).rejects.toMatchObject({
    status: 401,
  })
  const disabled = await ctx.workspaceFile.spaces(1, '群聊')
  expect(disabled.entries[0]).toMatchObject({ id: group.id, quota: 50 })
  await reloaded.dispose()
  expect((await ctx.workspaceFile.spaces(1, '')).total).toBe(2)
  await ctx.plugin(identityIm)
  expect((await ctx.workspaceFile.spaces(1, '群聊')).entries).toEqual(disabled.entries)
})

it('非Web身份的手工空间授权只作用于指定群，不接受system范围扩散', async () => {
  const { ctx, received, register } = await setup(),
    a = await register('a', '05')
  ctx.rbac.registerPermission(ctx, 'test.im.manage', '群管理测试', [])
  await a.receive(message())
  await a.receive(message('2', 'fish', 'other'))
  const [one, two] = received as [MessageContext, MessageContext]
  const db = ctx.database.scope<RbacTables>(ctx, '@antarestra/rbac')
  await db
    .insertInto('role')
    .values({ id: 'im-manager', name: '群管理员', status: 'active' })
    .execute()
  await db
    .insertInto('role_permission')
    .values({ role_id: 'im-manager', permission: 'test.im.manage' })
    .execute()
  await ctx.database.transaction(ctx, async (transaction) => {
    await ctx.rbac.grantRole(transaction, {
      principalId: one.actorId,
      roleId: 'im-manager',
      scope: one.workspaceId,
      source: 'manual',
    })
  })
  await expect(
    ctx.rbac.authorizeRequest('im', one.request, 'test.im.manage'),
  ).resolves.toMatchObject({ actorId: one.actorId })
  await expect(ctx.rbac.authorizeRequest('im', two.request, 'test.im.manage')).rejects.toThrow(
    '没有操作权限',
  )
  await ctx.database.transaction(ctx, async (transaction) => {
    await ctx.rbac.grantRole(transaction, {
      principalId: one.actorId,
      roleId: 'im-manager',
      scope: 'system',
      source: 'manual',
    })
  })
  await expect(ctx.rbac.authorizeRequest('im', two.request, 'test.im.manage')).rejects.toThrow(
    '没有操作权限',
  )
})
