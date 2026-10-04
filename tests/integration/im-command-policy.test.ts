import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import commands from '@antarestra/plugin-im-commands'
import type { ChatTarget, ConnectionPolicy } from '@antarestra/im'
import type { Context } from '@antarestra/plugin-sdk'
import { allowCommand, cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const openPolicy: ConnectionPolicy = {
  group: { mode: 'blacklist', ids: [] },
  private: { mode: 'blacklist', ids: [] },
}

it('新指令默认空白名单，数据库权限保存后即时生效，拒绝不落入其他处理器', async () => {
  const app = await setup({ allowCommands: false })
  const connection = app.connect('policy', 'bot', openPolicy)
  expect(await app.ctx.imCommands.getPolicy('ping')).toEqual({
    revision: 0,
    policy: {
      access: 'user',
      group: { mode: 'whitelist', ids: [] },
      private: { mode: 'whitelist', ids: [] },
    },
  })
  await connection.receive('/ping')
  await connection.receive('/ping', { chat: { type: 'private', id: 'user' } })
  expect(app.sent).toEqual([])
  expect(app.messages).toEqual([])
  await allowCommand(app.ctx, 'ping')
  await connection.receive('/ping')
  await connection.receive('/ping', { chat: { type: 'private', id: 'user' } })
  expect(app.sent).toHaveLength(2)
})

it.each(['group', 'private'] as const)('%s 的白黑名单按首词控制所有子命令', async (type) => {
  const app = await setup()
  const connection = app.connect('policy', 'bot', openPolicy)
  const execute = vi.fn(() => '完成')
  app.ctx.imCommands.register(app.ctx, { name: 'echo', description: '测试', execute })
  await allowCommand(app.ctx, 'echo', { [type]: { mode: 'whitelist', ids: ['allowed'] } })
  await allowCommand(app.ctx, 'ping', { [type]: { mode: 'blacklist', ids: ['blocked'] } })
  for (const text of ['/echo add "未闭合', '/echo delete x', '/ping'])
    await connection.receive(text, { chat: { type, id: 'blocked' } })
  expect(execute).not.toHaveBeenCalled()
  expect(app.messages).toEqual([])
  expect(app.sent).toEqual([])
  for (const text of ['/echo add x', '/echo\tdelete x', '/ping'])
    await connection.receive(text, { chat: { type, id: 'allowed' } })
  expect(execute).toHaveBeenCalledTimes(2)
  expect(app.sent).toHaveLength(3)
  await connection.receive('/echo-other x', { chat: { type, id: 'blocked' } })
  expect(app.messages).toHaveLength(1)
})

it('群聊先检查名单，只有群主和本群 bot 管理员能执行高级命令', async () => {
  const app = await setup()
  await allowCommand(app.ctx, 'ping', {
    access: 'bot-admin',
    group: { mode: 'blacklist', ids: ['blocked'] },
  })
  const getMember = vi.fn(async (_chat: ChatTarget, id: string) => ({
    active: true,
    role:
      id === 'owner'
        ? ('owner' as const)
        : id === 'platform-admin'
          ? ('admin' as const)
          : ('member' as const),
  }))
  const connection = app.connect('policy', 'bot', openPolicy, undefined, getMember)
  const receive = (user: string, group = 'g1') =>
    connection.receive('/ping', {
      chat: { type: 'group', id: group },
      sender: { id: user, role: 'owner' },
    })
  await receive('owner', 'blocked')
  expect(getMember).not.toHaveBeenCalled()
  expect(app.sent).toEqual([])
  await receive('owner')
  const workspace = (await app.ctx.im.listGroups(0, 20)).groups.find(
    (group) => group.chatId === 'g1',
  )!.workspaceId
  await app.ctx.imCommands.admins.set(workspace, ['delegate'], 0)
  await receive('delegate')
  expect(app.sent).toHaveLength(2)
  await receive('member')
  await receive('platform-admin')
  await receive('delegate', 'g2')
  expect(
    app.sent.slice(2).every((item) => JSON.stringify(item.segments).includes('仅当前群')),
  ).toBe(true)
  await receive('delegate', 'blocked')
  expect(app.sent).toHaveLength(5)
})

it.each(['whitelist', 'blacklist'] as const)(
  '私聊高级命令只检查 %s 名单，帮助使用相同规则',
  async (mode) => {
    const app = await setup()
    const connection = app.connect('policy', 'bot', openPolicy)
    app.ctx.imCommands.register(app.ctx, {
      name: 'high',
      access: 'bot-admin',
      description: '高级',
      execute: () => '完成',
    })
    await allowCommand(app.ctx, 'high', {
      private: { mode, ids: [mode === 'whitelist' ? 'allowed' : 'blocked'] },
    })
    const allowed = vi
      .spyOn(app.ctx.imCommands.admins, 'allowed')
      .mockRejectedValue(new Error('不应查询'))
    await connection.receive('/high', { chat: { type: 'private', id: 'blocked' } })
    await connection.receive('/high', { chat: { type: 'private', id: 'allowed' } })
    await connection.receive('/help', { chat: { type: 'private', id: 'allowed' } })
    expect(app.sent).toHaveLength(2)
    expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '完成' }])
    expect(JSON.stringify(app.sent[1]?.segments)).toContain('/high')
    expect(allowed).not.toHaveBeenCalled()
  },
)

it('数据库级别覆盖声明，帮助过滤名单与业务 RBAC 权限', async () => {
  const app = await setup()
  await allowCommand(app.ctx, 'admin', { access: 'user' })
  await allowCommand(app.ctx, 'ping', { access: 'bot-admin' })
  app.ctx.rbac.registerPermission(app.ctx, 'im.private.manage', '业务权限', ['admin'])
  app.ctx.imCommands.register(app.ctx, {
    name: 'restricted',
    access: 'bot-admin',
    permission: 'im.private.manage',
    description: '受限',
    execute: () => '不应执行',
  })
  await allowCommand(app.ctx, 'restricted')
  await app.connection.receive('/admin add delegate')
  const workspace = (await app.ctx.im.listGroups(0, 20)).groups[0]!.workspaceId
  expect((await app.ctx.imCommands.admins.get(workspace)).users).toEqual(['delegate'])
  await app.connection.receive('/help')
  expect(JSON.stringify(app.sent.at(-1)?.segments)).not.toContain('/ping')
  const connection = app.connect('policy', 'bot', openPolicy)
  await connection.receive('/restricted', { chat: { type: 'private', id: 'user' } })
  expect(JSON.stringify(app.sent.at(-1)?.segments)).toContain('没有执行')
})

it('AI 入口自动注册，名单和命令开关拒绝后不调用模型', async () => {
  const app = await setup({ ai: true })
  expect((await app.ctx.imCommands.listCommands()).commands.map((item) => item.name)).toContain(
    'ai',
  )
  await allowCommand(app.ctx, 'ai', { group: { mode: 'whitelist', ids: [] } })
  await app.connection.receive('/ai 拒绝')
  expect(await app.jobs()).toEqual([])
  expect(app.messages).toEqual([])
  await allowCommand(app.ctx, 'ai')
  await app.connection.receive('/ai 放行')
  await expect.poll(async () => (await app.jobs())[0]?.delivery, { timeout: 5000 }).toBe('sent')
  await app.ctx.im.setPolicy('qq-a', { ...app.defaultPolicy, defaults: { commands: false } })
  await app.connection.receive('/ai 关闭')
  expect(await app.jobs()).toHaveLength(1)
  expect(app.aiState.calls).toBe(1)
})

it('权限跨插件卸载和数据库重开持久化，离线指令不出现在注册目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'command-persistence-'))
  try {
    const databaseFilename = join(directory, 'test.db')
    const app = await setup({ allowCommands: false, databaseFilename })
    await allowCommand(app.ctx, 'ping', { access: 'bot-admin' })
    const plugin = {
      inject: ['imCommands'],
      apply(ctx: Context) {
        ctx.imCommands.register(ctx, {
          name: 'temporary',
          description: '临时',
          execute: () => '完成',
        })
      },
    }
    const fiber = await app.ctx.plugin(plugin)
    await allowCommand(app.ctx, 'temporary')
    await fiber.dispose()
    expect(
      (await app.ctx.imCommands.listCommands()).commands.some((item) => item.name === 'temporary'),
    ).toBe(false)
    await expect(app.ctx.imCommands.setPolicy('temporary', {}, 0)).rejects.toMatchObject({
      status: 404,
    })
    await app.ctx.plugin(plugin)
    expect((await app.ctx.imCommands.getPolicy('temporary')).policy.group.mode).toBe('blacklist')
    await cleanup()
    const reopened = await setup({ allowCommands: false, databaseFilename })
    expect(await reopened.ctx.imCommands.getPolicy('ping')).toMatchObject({
      revision: 1,
      policy: { access: 'bot-admin', group: { mode: 'blacklist' } },
    })
    await reopened.commandPlugin.dispose()
    await reopened.ctx.plugin(commands)
    expect((await reopened.ctx.imCommands.getPolicy('ping')).revision).toBe(1)
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})
