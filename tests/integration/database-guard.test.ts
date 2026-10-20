import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@antarestra/plugin-sdk'
import DatabaseProvider, { defineDatabasePlugin } from '@antarestra/database'
import type { DatabaseScope } from '@antarestra/database'
import * as implementation from '@antarestra/plugin-database-kysely'
import { initial } from '../fixtures/database.js'
import type { Tables } from '../fixtures/database.js'
import { TestRegistry } from '../fixtures/registry.js'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    databaseGuardProbe: DatabaseGuardProbe
  }
}

// 经真实服务代理获取 this.ctx，复现调用方不断产生影子上下文的路径。
class DatabaseGuardProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'databaseGuardProbe')
  }

  scope(pluginId: string) {
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }

  transaction(pluginId: string) {
    return this.ctx.database.transaction(this.ctx, async (transaction) => {
      const db = transaction.scope<Tables>(this.ctx, pluginId)
      return db.selectFrom('labels').select('id').execute()
    })
  }
}

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

async function setup() {
  const root = new Context()
  roots.push(root)
  await root.plugin(DatabaseProvider)
  await root.plugin(implementation, { type: 'sqlite', filename: ':memory:' })
  await root.plugin({
    inject: ['database'],
    async apply(ctx: Context) {
      await ctx.plugin(DatabaseGuardProbe)
    },
  })
  const pluginId = `test-${randomUUID()}`
  await root.plugin(defineDatabasePlugin({ name: pluginId, migrations: [initial], apply() {} }))
  return { root, pluginId }
}

async function consumer(root: Context, pluginId: string, dependencies: string[] = []) {
  let owner!: Context
  let starts = 0
  const plugin = {
    inject: ['database', 'databaseGuardProbe', ...dependencies],
    apply(ctx: Context) {
      owner = ctx
      starts++
    },
  }
  const fiber = await root.plugin(plugin)
  return {
    plugin,
    fiber,
    scope: () => owner.databaseGuardProbe.scope(pluginId),
    transaction: () => owner.databaseGuardProbe.transaction(pluginId),
    effects: () => owner.fiber.getEffects().length,
    get starts() {
      return starts
    },
  }
}

describe('数据库 guard 的影子上下文生命周期', () => {
  it('一万次代理 scope 调用及重复事务只保留一个 guard 回调', async () => {
    const { root, pluginId } = await setup()
    const client = await consumer(root, pluginId)
    const baseline = client.effects()
    for (let i = 0; i < 10_000; i++) {
      const db = client.scope()
      if (i % 2000 === 0) await db.selectFrom('labels').selectAll().execute()
    }
    expect(client.effects()).toBe(baseline + 1)
    for (let i = 0; i < 100; i++) expect(await client.transaction()).toEqual([])
    expect(client.effects()).toBe(baseline + 1)
  })

  it('两个调用方独立卸载，旧 scope 和已创建查询失效，另一个仍可读写', async () => {
    const { root, pluginId } = await setup()
    const first = await consumer(root, pluginId)
    const second = await consumer(root, pluginId)
    const old = first.scope()
    const live = second.scope()
    await old.insertInto('labels').values({ id: 'a', record_id: 'r', title: '保留数据' }).execute()
    const pending = old.selectFrom('labels').selectAll()
    const remaining = second.effects()
    await first.fiber.dispose()
    expect(first.effects()).toBe(0)
    expect(() => old.selectFrom('labels')).toThrow('已卸载')
    await expect(pending.execute()).rejects.toThrow('已卸载')
    await live.insertInto('labels').values({ id: 'b', record_id: 'r', title: '仍可写入' }).execute()
    for (let i = 0; i < 100; i++) {
      expect(
        await second.scope().selectFrom('labels').select('id').orderBy('id').execute(),
      ).toEqual([{ id: 'a' }, { id: 'b' }])
    }
    expect(second.effects()).toBe(remaining)
  })

  it('显式卸载并重新挂载后新 scope 可用，所有旧 scope 均保持失效', async () => {
    const { root, pluginId } = await setup()
    const client = await consumer(root, pluginId)
    let fiber = client.fiber
    const baseline = client.effects()
    const stale: DatabaseScope<Tables>[] = []
    for (let round = 0; round < 3; round++) {
      stale.push(client.scope())
      for (let i = 0; i < 100; i++) client.scope()
      expect(client.effects()).toBe(baseline + 1)
      await fiber.dispose()
      const previous = fiber
      fiber = await root.plugin(client.plugin)
      expect(fiber).not.toBe(previous)
      expect(await client.scope().selectFrom('labels').selectAll().execute()).toEqual([])
      for (const db of stale) expect(() => db.selectFrom('labels')).toThrow('已卸载')
      expect(client.effects()).toBe(baseline + 1)
    }
  })

  it('依赖恢复复用同一个 Fiber 时重新注册 guard，旧代 scope 不会复活', async () => {
    const { root, pluginId } = await setup()
    let dependency = await root.plugin(TestRegistry)
    const client = await consumer(root, pluginId, ['testRegistry'])
    const stale: DatabaseScope<Tables>[] = []
    for (let round = 0; round < 3; round++) {
      const baseline = client.effects()
      stale.push(client.scope())
      for (let i = 0; i < 100; i++) client.scope()
      expect(client.effects()).toBe(baseline + 1)
      await dependency.dispose()
      expect(client.effects()).toBe(0)
      for (const db of stale) expect(() => db.selectFrom('labels')).toThrow('已卸载')
      dependency = await root.plugin(TestRegistry)
      await client.fiber.await()
      expect(client.starts).toBe(round + 2)
      expect(client.effects()).toBe(baseline)
    }
    expect(await client.scope().selectFrom('labels').selectAll().execute()).toEqual([])
    for (const db of stale) expect(() => db.selectFrom('labels')).toThrow('已卸载')
  })
})
