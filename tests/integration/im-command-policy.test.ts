import { afterEach, expect, it, vi } from 'vitest'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import commands, { type Config } from '@antarestra/plugin-im-commands'
import type { ChatTarget, ConnectionPolicy } from '@antarestra/im'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const openPolicy: ConnectionPolicy = {
  group: { mode: 'blacklist', ids: [] },
  private: { mode: 'blacklist', ids: [] },
}

it.each(['group', 'private'] as const)(
  '%s 的白名单和黑名单按完整首词统一控制所有子命令',
  async (type) => {
    const app = await setup({
      commands: {
        commands: {
          echo: { [type]: { mode: 'whitelist', ids: ['allowed'] } },
          ping: { [type]: { mode: 'blacklist', ids: ['blocked'] } },
        },
      },
    })
    const connection = app.connect('policy', 'bot', openPolicy)
    const execute = vi.fn(({ rawArgs }: { rawArgs: string }) => rawArgs)
    app.ctx.imCommands.register(app.ctx, { name: 'echo', description: '测试', execute })
    const receive = (text: string, id: string) => connection.receive(text, { chat: { type, id } })
    await receive('/echo add "未闭合', 'blocked')
    await receive('/echo delete x', 'blocked')
    await receive('/ping', 'blocked')
    expect(app.sent).toEqual([])
    expect(app.messages).toEqual([])
    expect(execute).not.toHaveBeenCalled()
    await receive('/echo add x', 'allowed')
    await receive('/echo\tdelete x', 'allowed')
    await receive('/ping', 'allowed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(app.sent.map((item) => item.segments)).toEqual([
      [{ type: 'text', text: 'add x' }],
      [{ type: 'text', text: 'delete x' }],
      [{ type: 'text', text: 'pong' }],
    ])
    await receive('/echo-other add x', 'blocked')
    expect(app.messages).toHaveLength(1)
  },
)

it('群聊先校验名单，群主和本群 bot 管理员可执行高级命令，平台管理员和伪造角色无效', async () => {
  const app = await setup({
    commands: {
      commands: {
        ping: { access: 'bot-admin', group: { mode: 'blacklist', ids: ['blocked'] } },
      },
    },
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
  const groups = (await app.ctx.im.listGroups(0, 20)).groups
  const workspace = groups.find((group) => group.chatId === 'g1')!.workspaceId
  await app.ctx.imCommands.admins.set(workspace, ['delegate'], 0)
  await receive('delegate')
  expect(app.sent.map((item) => item.segments)).toEqual([
    [{ type: 'text', text: 'pong' }],
    [{ type: 'text', text: 'pong' }],
  ])
  await receive('member')
  await receive('platform-admin')
  await receive('delegate', 'g2')
  expect(
    app.sent.slice(2).every((item) => JSON.stringify(item.segments).includes('仅当前群')),
  ).toBe(true)
  await receive('delegate', 'blocked')
  expect(app.sent).toHaveLength(5)
  expect(app.messages).toEqual([])
})

it('私聊不检查授权级别，但业务要求的 RBAC 权限仍须满足', async () => {
  const app = await setup()
  const connection = app.connect('policy', 'bot', openPolicy)
  app.ctx.rbac.registerPermission(app.ctx, 'im.private.manage', '私聊业务管理', ['admin'])
  const execute = vi.fn()
  app.ctx.imCommands.register(app.ctx, {
    name: 'restricted',
    access: 'bot-admin',
    permission: 'im.private.manage',
    description: '受限',
    execute,
  })
  await connection.receive('/restricted', { chat: { type: 'private', id: 'user' } })
  await connection.receive('/help', { chat: { type: 'private', id: 'user' } })
  expect(execute).not.toHaveBeenCalled()
  expect(JSON.stringify(app.sent[0]?.segments)).toContain('没有执行')
  expect(JSON.stringify(app.sent[1]?.segments)).not.toContain('/restricted')
})

it('集中配置的 AI 前缀先经过命令名单，拒绝后不会由 AI 或其他处理器再次处理', async () => {
  const app = await setup({
    ai: true,
    commands: {
      commands: {
        ai: {
          group: { mode: 'whitelist', ids: ['allowed'] },
          private: { mode: 'whitelist', ids: [] },
        },
      },
    },
  })
  await app.connection.receive('/ai 不应运行')
  expect(await app.jobs()).toEqual([])
  expect(app.messages).toEqual([])
  expect(app.aiState.calls).toBe(0)
  const policy: ConnectionPolicy = { ...openPolicy, defaults: { ai: true, agentId: 'assistant' } }
  const connection = app.connect('policy', 'bot', policy)
  await connection.receive('/ai 私聊拒绝', { chat: { type: 'private', id: 'user' } })
  expect(await app.jobs()).toEqual([])
  await connection.receive('/ai 允许运行', { chat: { type: 'group', id: 'allowed' } })
  await expect.poll(() => app.aiState.calls, { timeout: 5000 }).toBe(1)
  await expect.poll(async () => (await app.jobs())[0]?.delivery, { timeout: 5000 }).toBe('sent')
  await app.ctx.im.setPolicy('policy', {
    ...policy,
    defaults: { ...policy.defaults, commands: false },
  })
  await connection.receive('/ai 命令已关闭', { chat: { type: 'group', id: 'allowed' } })
  expect(await app.jobs()).toHaveLength(1)
  expect(app.messages).toHaveLength(1)
})

it('修改集中配置并重新加载后使用新名单，卸载的配置不会残留', async () => {
  const app = await setup({
    commands: {
      prefix: '!',
      commands: {
        ping: { group: { mode: 'whitelist', ids: [] } },
      },
    },
  })
  await app.connection.receive('!ping')
  expect(app.sent).toEqual([])
  await app.commandPlugin.dispose()
  await app.ctx.plugin(commands, {
    prefix: '!',
    commands: {
      ping: { group: { mode: 'blacklist', ids: [] } },
    },
  })
  await app.connection.receive('!ping')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: 'pong' }])
})

it('配置校验拒绝多词键、带前缀键、错误级别及不完整名单，不把缺省字段填成覆盖值', () => {
  const url = new URL('../../plugins/features/im-commands/config.schema.json', import.meta.url)
  const parse = (input: unknown) => schemaConfig<Config>(url, input)
  expect(parse({})).toEqual({ prefix: '/', builtins: true, commands: {} })
  expect(parse({ commands: { sticker: {} } }).commands.sticker).toEqual({})
  for (const rules of [
    { 'sticker add': {} },
    { '/sticker': {} },
    { sticker: { access: 'admin' } },
    { sticker: { group: {} } },
    { sticker: { private: { mode: 'whitelist' } } },
    { sticker: { group: { mode: 'whitelist', ids: [123] } } },
    { sticker: { group: { mode: 'whitelist', ids: [' '] } } },
  ])
    expect(() => parse({ commands: rules })).toThrow('配置校验失败')
})

it.each(['whitelist', 'blacklist'] as const)(
  '私聊高级命令只按 %s 名单放行，不查询群主或管理员',
  async (mode) => {
    const app = await setup({
      commands: {
        commands: {
          high: { private: { mode, ids: [mode === 'whitelist' ? 'allowed' : 'blocked'] } },
        },
      },
    })
    const connection = app.connect('policy', 'bot', openPolicy)
    const allowed = vi
      .spyOn(app.ctx.imCommands.admins, 'allowed')
      .mockRejectedValue(new Error('不应查询'))
    const execute = vi.fn(() => '完成')
    app.ctx.imCommands.register(app.ctx, {
      name: 'high',
      access: 'bot-admin',
      description: '高级',
      execute,
    })
    await connection.receive('/high', { chat: { type: 'private', id: 'blocked' } })
    await connection.receive('/high', { chat: { type: 'private', id: 'allowed' } })
    await connection.receive('/help', { chat: { type: 'private', id: 'allowed' } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '完成' }])
    expect(JSON.stringify(app.sent[1]?.segments)).toContain('/high')
    expect(allowed).not.toHaveBeenCalled()
  },
)

it('集中配置可覆盖插件声明的级别，帮助列表使用相同的名单和有效级别', async () => {
  const app = await setup({
    commands: {
      commands: {
        high: { access: 'user' },
        admin: { access: 'user' },
        ping: { access: 'bot-admin' },
        hidden: { group: { mode: 'whitelist', ids: [] } },
      },
    },
  })
  app.ctx.imCommands.register(app.ctx, {
    name: 'high',
    access: 'bot-admin',
    description: '高级',
    execute: () => '完成',
  })
  app.ctx.imCommands.register(app.ctx, {
    name: 'hidden',
    description: '隐藏',
    execute: () => '隐藏',
  })
  await app.connection.receive('/high')
  await app.connection.receive('/help')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '完成' }])
  const help = JSON.stringify(app.sent[1]?.segments)
  expect(help).toContain('/high')
  expect(help).not.toContain('bot 管理）')
  expect(help).not.toContain('/ping')
  expect(help).not.toContain('/hidden')
  await app.connection.receive('/admin add delegate')
  const workspace = (await app.ctx.im.listGroups(0, 20)).groups[0]!.workspaceId
  expect((await app.ctx.imCommands.admins.get(workspace)).users).toEqual(['delegate'])
})

it('名单缺省不额外限制，空白名单拒绝、空黑名单放行，接入层拒绝和命令开关仍生效', async () => {
  const app = await setup({
    commands: {
      commands: {
        ping: { group: { mode: 'blacklist', ids: [] }, private: { mode: 'whitelist', ids: [] } },
      },
    },
  })
  await app.connection.receive('/ping')
  await app.connection.receive('/ping', { chat: { type: 'group', id: 'outside' } })
  const connection = app.connect('policy', 'bot', openPolicy)
  await connection.receive('/ping', { chat: { type: 'private', id: 'user' } })
  await connection.receive('/help', { chat: { type: 'private', id: 'user' } })
  expect(JSON.stringify(app.sent.at(-1)?.segments)).not.toContain('/ping')
  await app.ctx.im.setPolicy('qq-a', { ...app.defaultPolicy, defaults: { commands: false } })
  await app.connection.receive('/ping')
  expect(app.sent).toHaveLength(2)
  expect(app.messages).toEqual([])
})
