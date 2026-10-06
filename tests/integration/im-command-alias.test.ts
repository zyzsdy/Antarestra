import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import commands from '@antarestra/plugin-im-commands'
import type { CommandContext } from '@antarestra/plugin-im-commands'
import { allowCommand, cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)

it.each(['group', 'private'] as const)(
  '%s 别名按自己的名单执行，原样追加参数且不影响目标或其他别名',
  async (type) => {
    const app = await setup({ allowCommands: false })
    const connection = await app.connect('alias', 'bot', {
      group: { mode: 'blacklist', ids: [] },
      private: { mode: 'blacklist', ids: [] },
    })
    const execute = vi.fn((_: CommandContext) => '完成')
    app.ctx.imCommands.register(app.ctx, { name: 'commit', description: '提交', execute })
    await app.ctx.imCommands.createAlias('/user1Commit', '/commit user1')
    await app.ctx.imCommands.createAlias('/user2Commit', '/commit user2')
    const chat = { type, id: 'allowed' }
    await connection.receive('/user1Commit --name "aaa1"', { chat })
    expect(execute).not.toHaveBeenCalled()
    await allowCommand(app.ctx, 'user1Commit', { [type]: { mode: 'whitelist', ids: ['allowed'] } })
    const suffix = '  --name "aaa1"\t\'两个 参数\' \\"x\\" "" a\\ b  '
    await connection.receive('/user1Commit' + suffix, { chat })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0]).toMatchObject({
      rawArgs: 'user1' + suffix,
      args: ['user1', '--name', 'aaa1', '两个 参数', '"x"', '', 'a b'],
      message: { segments: [{ type: 'text', text: '/commit user1' + suffix }] },
    })
    await connection.receive('/commit user1', { chat })
    await connection.receive('/user2Commit', { chat })
    await connection.receive('/user1Commit', { chat: { type, id: 'blocked' } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(app.messages).toEqual([])
    await allowCommand(app.ctx, 'commit')
    await allowCommand(app.ctx, 'user1Commit', { [type]: { mode: 'blacklist', ids: ['allowed'] } })
    await connection.receive('/user1Commit', { chat })
    await connection.receive('/commit user1', { chat })
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await app.ctx.imCommands.getPolicy('user2Commit')).revision).toBe(0)
  },
)

it('别名自己的授权级别、帮助过滤和业务 RBAC 校验仍然生效', async () => {
  const app = await setup()
  const execute = vi.fn(() => '完成')
  app.ctx.imCommands.register(app.ctx, {
    name: 'commit',
    access: 'bot-admin',
    description: '提交',
    execute,
  })
  await app.ctx.imCommands.createAlias('/user1Commit', '/commit user1')
  await allowCommand(app.ctx, 'user1Commit')
  await app.connection.receive('/user1Commit')
  expect(execute).toHaveBeenCalledTimes(1)
  await app.connection.receive('/help')
  expect(JSON.stringify(app.sent.at(-1)?.segments)).toContain('/user1Commit')
  await allowCommand(app.ctx, 'user1Commit', { access: 'bot-admin' })
  await app.connection.receive('/user1Commit')
  expect(execute).toHaveBeenCalledTimes(1)
  await app.connection.receive('/help')
  expect(JSON.stringify(app.sent.at(-1)?.segments)).not.toContain('/user1Commit')
  app.ctx.rbac.registerPermission(app.ctx, 'alias.secret.use', '业务权限', ['admin'])
  app.ctx.imCommands.register(app.ctx, {
    name: 'secret',
    description: '受限',
    permission: 'alias.secret.use',
    execute,
  })
  await app.ctx.imCommands.createAlias('/secretAlias', '/secret')
  await allowCommand(app.ctx, 'secretAlias')
  await app.connection.receive('/secretAlias')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(app.sent.at(-1)?.segments)).toContain('没有执行')
})

it('别名转发触发入口，保留可信空间及原始归档，不受目标名单影响', async () => {
  const app = await setup({ ai: true })
  await allowCommand(app.ctx, 'ai', { group: { mode: 'whitelist', ids: [] } })
  await app.ctx.imCommands.createAlias('/ask', '/ai 固定提示')
  await allowCommand(app.ctx, 'ask')
  await app.connection.receive('/ask "问题"')
  await expect.poll(async () => (await app.jobs())[0]?.delivery, { timeout: 5000 }).toBe('sent')
  const captured = app.messages.at(-1)!
  expect(captured.message.segments).toEqual([{ type: 'text', text: '/ai 固定提示 "问题"' }])
  expect(captured.archived?.message.segments).toEqual([{ type: 'text', text: '/ask "问题"' }])
  expect((await app.ctx.im.authenticate(captured.request))?.workspaceId).toBe(captured.workspaceId)
  await app.connection.receive('/ai 不允许')
  await allowCommand(app.ctx, 'ask', { group: { mode: 'whitelist', ids: [] } })
  await app.connection.receive('/ask 不允许')
  expect(await app.jobs()).toHaveLength(1)
  expect(app.messages).toHaveLength(1)
})

it('admin 别名的内部复核也使用别名权限，接入命令开关仍然限制调用', async () => {
  const app = await setup({ allowCommands: false })
  await app.ctx.imCommands.createAlias('/delegate', '/admin add')
  await allowCommand(app.ctx, 'delegate')
  await app.connection.receive('/delegate user1')
  const workspace = (await app.ctx.im.listGroups()).groups[0]!.workspaceId
  expect((await app.ctx.imCommands.admins.get(workspace)).users).toEqual(['user1'])
  await app.ctx.im.setPolicy('qq-a', { ...app.defaultPolicy, defaults: { commands: false } })
  await app.connection.receive('/delegate user2')
  expect((await app.ctx.imCommands.admins.get(workspace)).users).toEqual(['user1'])
})

it('拒绝无效目标、别名链、重名和并发创建，精确匹配首词并复用参数数量校验', async () => {
  const app = await setup()
  for (const [name, target] of [
    ['a b', '/ping'],
    ['a', '/missing'],
    ['a', 'ping'],
    ['a', '/ping "'],
    ['a', '/ping x\\'],
  ])
    await expect(app.ctx.imCommands.createAlias(name, target)).rejects.toMatchObject({
      status: 400,
    })
  await expect(app.ctx.imCommands.createAlias('/ping', '/help')).rejects.toMatchObject({
    status: 409,
  })
  const race = await Promise.allSettled(
    [1, 2].map(() => app.ctx.imCommands.createAlias('/Pong', '/ping')),
  )
  expect(race.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  await expect(app.ctx.imCommands.createAlias('/next', '/Pong')).rejects.toMatchObject({
    status: 400,
  })
  expect(() =>
    app.ctx.imCommands.register(app.ctx, { name: 'Pong', description: '冲突', execute() {} }),
  ).toThrow()
  await allowCommand(app.ctx, 'Pong')
  await app.connection.receive('/Pong extra')
  expect(JSON.stringify(app.sent.at(-1)?.segments)).toContain('用法：/ping')
  await app.connection.receive('/Pong "')
  expect(JSON.stringify(app.sent.at(-1)?.segments)).toContain('未闭合')
  await app.connection.receive('/pong')
  await app.connection.receive('/PongMore')
  expect(app.messages).toHaveLength(2)
})

it('别名及独立权限在数据库重开后恢复，目标卸载不会落入 AI，删除重建默认禁用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'command-alias-'))
  try {
    const databaseFilename = join(directory, 'test.db')
    const app = await setup({ databaseFilename })
    await app.ctx.imCommands.createAlias('/Pong', '/ping')
    await allowCommand(app.ctx, 'Pong')
    await cleanup()
    const reopened = await setup({
      databaseFilename,
      allowCommands: false,
      commands: { prefix: '!' },
    })
    await reopened.connection.receive('!Pong')
    expect(reopened.sent.at(-1)?.segments).toEqual([{ type: 'text', text: 'pong' }])
    await reopened.commandPlugin.dispose()
    await reopened.ctx.plugin(commands, { prefix: '!', builtins: false })
    await reopened.connection.receive('!Pong')
    expect(JSON.stringify(reopened.sent.at(-1)?.segments)).toContain('目标命令不可用')
    expect(reopened.messages).toEqual([])
    const item = (await reopened.ctx.imCommands.listCommands(0, 'Pong')).commands[0]!
    expect(item.alias).toMatchObject({ target: '!ping', available: false })
    await expect(reopened.ctx.imCommands.deleteAlias('Pong', 'old')).rejects.toMatchObject({
      status: 409,
    })
    await reopened.ctx.imCommands.deleteAlias('Pong', item.alias!.id)
    await reopened.ctx.imCommands.createAlias('Pong', '!admin add')
    expect((await reopened.ctx.imCommands.getPolicy('Pong')).revision).toBe(0)
    await expect(reopened.ctx.imCommands.deleteAlias('Pong', item.alias!.id)).rejects.toMatchObject(
      { status: 409 },
    )
  } finally {
    await cleanup()
    await rm(directory, { recursive: true, force: true })
  }
})

it('目标卸载会取消并等待通过别名启动的命令', async () => {
  const app = await setup()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let aborted = false
  const dispose = app.ctx.imCommands.register(app.ctx, {
    name: 'wait',
    description: '等待',
    execute: ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        )
        started()
      }),
  })
  await app.ctx.imCommands.createAlias('/waiting', '/wait')
  await allowCommand(app.ctx, 'waiting')
  const running = app.connection.receive('/waiting')
  await ready
  await dispose()
  await running
  expect(aborted).toBe(true)
  expect(app.sent).toEqual([])
})
