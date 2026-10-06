import { afterEach, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@antarestra/plugin-sdk'
import { parseArguments } from '@antarestra/plugin-im-commands'
import { allowCommand, cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
it('数字开头的命令复用权限策略、帮助和精确匹配，卸载后可重新注册', async () => {
  const app = await setup()
  const register = () =>
    app.ctx.plugin({
      inject: ['imCommands'],
      apply(owner: Context) {
        owner.imCommands.register(owner, {
          name: '2fa',
          description: '数字开头的测试命令',
          usage: '<标识符>',
          minArgs: 1,
          maxArgs: 1,
          execute: ({ args }) => `收到：${args[0]}`,
        })
      },
    })
  const first = await register()
  await app.connection.receive('/2fa example')
  expect(app.sent).toHaveLength(0)
  expect(app.messages).toHaveLength(0)
  await allowCommand(app.ctx, '2fa')
  await app.connection.receive('/2fa example')
  await app.connection.receive('/help')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: '收到：example' }])
  expect(JSON.stringify(app.sent[1]?.segments)).toContain('/2fa <标识符>')
  await app.connection.receive('/2fa-other example')
  expect(app.messages).toHaveLength(1)
  await first.dispose()
  expect(
    (await app.ctx.imCommands.listCommands()).commands.some((item) => item.name === '2fa'),
  ).toBe(false)
  await register()
  await app.connection.receive('/2fa restored')
  expect(app.sent.at(-1)?.segments).toEqual([{ type: 'text', text: '收到：restored' }])
  for (const name of ['', '_2fa', '-2fa', '/2fa', 'two words', 'A2fa']) {
    expect(() =>
      app.ctx.imCommands.register(app.ctx, { name, description: '非法命令', execute: () => '' }),
    ).toThrow('命令名称无效')
  }
})

it('没有 AI 插件仍可 ping/help，且只在白名单群响应', async () => {
  const app = await setup()
  await app.connection.receive('/ping')
  await app.connection.receive('/help')
  expect(app.sent[0]?.segments).toEqual([{ type: 'text', text: 'pong' }])
  expect(JSON.stringify(app.sent[1]?.segments)).toContain('/ping')
  expect(app.messages).toHaveLength(0)
  await app.connection.receive('/ping', { chat: { type: 'group', id: 'other' } })
  await app.connection.receive('/ping', { chat: { type: 'private', id: '79338528' } })
  expect(app.sent).toHaveLength(2)
})
it('固定命令解析参数并检查权限，所有命中包括错误都消费消息', async () => {
  const app = await setup()
  let calls = 0
  app.ctx.rbac.registerPermission(app.ctx, 'im.members.manage', '管理成员', ['admin'])
  app.ctx.imCommands.register(app.ctx, {
    name: 'restricted',
    description: '管理群成员',
    permission: 'im.members.manage',
    execute: () => {
      calls++
      return '不应执行'
    },
  })
  app.ctx.imCommands.register(app.ctx, {
    name: 'echo',
    description: '回显',
    minArgs: 1,
    maxArgs: 2,
    execute: ({ args }) => args.join('|'),
  })
  await allowCommand(app.ctx, 'restricted')
  await allowCommand(app.ctx, 'echo')
  await app.connection.receive('/restricted set 000000')
  await app.connection.receive('/echo "two words" x')
  await app.connection.receive('/echo "broken')
  await app.connection.receive('/echo')
  await app.connection.receive('/echo a b c')
  expect(calls).toBe(0)
  expect(app.sent.map((item) => JSON.stringify(item.segments))).toEqual([
    expect.stringContaining('没有执行'),
    expect.stringContaining('two words|x'),
    expect.stringContaining('未闭合'),
    expect.stringContaining('用法'),
    expect.stringContaining('用法'),
  ])
  expect(app.messages).toHaveLength(0)
  expect(parseArguments("a '' 'b c' d\\ e")).toEqual(['a', '', 'b c', 'd e'])
})
it.each([
  { error: new Error('目标服务返回 503\n请检查连接'), detail: '目标服务返回 503\n请检查连接' },
  { error: '原始命令拒绝执行', detail: '原始命令拒绝执行' },
  { error: new Error(''), detail: '未知错误' },
])('命令同步和异步失败均回复原始错误并消费消息：$detail', async ({ error, detail }) => {
  const app = await setup()
  app.ctx.imCommands.register(app.ctx, {
    name: 'fail-sync',
    description: '同步失败',
    execute: () => {
      throw error
    },
  })
  app.ctx.imCommands.register(app.ctx, {
    name: 'fail-async',
    description: '异步失败',
    execute: async () => {
      throw error
    },
  })
  for (const name of ['fail-sync', 'fail-async']) {
    await allowCommand(app.ctx, name)
    await app.connection.receive(`/${name}`)
  }
  expect(app.sent.map((item) => item.segments)).toEqual([
    [{ type: 'text', text: `命令执行失败：${detail}` }],
    [{ type: 'text', text: `命令执行失败：${detail}` }],
  ])
  expect(app.messages).toHaveLength(0)
})

it('业务插件卸载后回收命令，命令关闭时不会落入 AI', async () => {
  const app = await setup()
  const plugin = await app.ctx.plugin({
    inject: ['imCommands'],
    apply(owner: Context) {
      owner.imCommands.register(owner, {
        name: 'owned',
        description: '临时命令',
        execute: () => '可用',
      })
    },
  })
  await allowCommand(app.ctx, 'owned')
  await app.connection.receive('/owned')
  await plugin.dispose()
  await app.connection.receive('/owned')
  expect(app.sent).toHaveLength(1)
  expect(app.messages).toHaveLength(1)
  await app.ctx.im.setPolicy('qq-a', { ...app.defaultPolicy, defaults: { commands: false } })
  await app.connection.receive('/ping')
  expect(app.sent).toHaveLength(1)
  expect(app.messages).toHaveLength(1)
})

it('所属业务插件卸载会取消正在执行的命令并等待清理', async () => {
  const app = await setup()
  let started = false
  let cancelled = false
  const plugin = await app.ctx.plugin({
    inject: ['imCommands'],
    apply(owner: Context) {
      owner.imCommands.register(owner, {
        name: 'waiting',
        description: '等待',
        async execute({ signal }) {
          started = true
          try {
            await delay(60000, undefined, { signal })
          } finally {
            cancelled = signal.aborted
          }
        },
      })
    },
  })
  await allowCommand(app.ctx, 'waiting')
  const received = app.connection.receive('/waiting')
  await expect.poll(() => started).toBe(true)
  await plugin.dispose()
  await received
  expect(cancelled).toBe(true)
  expect(app.sent).toHaveLength(0)
})
