import { afterEach, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@antarestra/plugin-sdk'
import { parseArguments } from '@antarestra/plugin-im-commands'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
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
  const received = app.connection.receive('/waiting')
  await expect.poll(() => started).toBe(true)
  await plugin.dispose()
  await received
  expect(cancelled).toBe(true)
  expect(app.sent).toHaveLength(0)
})
