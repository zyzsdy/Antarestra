import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import { TestRegistry } from '../fixtures/registry.js'
import DatabaseProvider, {
  defineDatabasePlugin,
  defineMigration,
  values,
} from '@antarestra/database'
import type { DatabaseScope, Migration, Queries } from '@antarestra/database'
import * as implementation from '@antarestra/plugin-database-kysely'
import type { Config } from '@antarestra/plugin-database-kysely'
import { initial, upgrade, interrupted } from '../fixtures/database.js'
import type { Tables } from '../fixtures/database.js'

const contexts: Context[] = []
const directories: string[] = []
const id = () => `test-${randomUUID()}`
const record = (key = 'a', workspace = 'one') => ({
  id: key,
  workspace_id: workspace,
  title: `标题 ${key}`,
  enabled: values.boolean(true),
  created_at: values.timestamp(new Date('2026-09-11T00:00:00Z')),
  payload: values.json({ key, unicode: '中文' }),
  score: 1.25,
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function setup(config: Config) {
  const ctx = new Context()
  contexts.push(ctx)
  const definition = await ctx.plugin(DatabaseProvider)
  const backend = await ctx.plugin(implementation, config)
  return { ctx, definition, backend }
}

function consumer(
  pluginId: string,
  migrations: readonly Migration[] = [initial, upgrade],
  inject: readonly string[] = [],
) {
  let db: DatabaseScope<Tables>
  let starts = 0
  const plugin = defineDatabasePlugin({
    name: pluginId,
    migrations,
    inject,
    apply(ctx: Context) {
      starts++
      db = ctx.database.scope<Tables>(ctx, pluginId)
    },
  })
  return {
    plugin,
    get db() {
      return db!
    },
    get starts() {
      return starts
    },
  }
}

const backends: { name: string; config: Config; enabled: boolean }[] = [
  { name: 'SQLite', config: { type: 'sqlite', filename: ':memory:' }, enabled: true },
  {
    name: 'PostgreSQL',
    config: { type: 'postgresql', url: process.env.ANTARESTRA_TEST_POSTGRES ?? '' },
    enabled: Boolean(process.env.ANTARESTRA_TEST_POSTGRES),
  },
  {
    name: 'MySQL',
    config: { type: 'mysql', url: process.env.ANTARESTRA_TEST_MYSQL ?? '' },
    enabled: Boolean(process.env.ANTARESTRA_TEST_MYSQL),
  },
]

for (const { name, config, enabled } of backends) {
  describe.skipIf(!enabled)(`database ${name} 真实数据库`, () => {
    it('同一插件完成建表、升级、CRUD、关联、别名、子查询与跨空间显式筛选', async () => {
      const { ctx } = await setup(config)
      const app = consumer(id())
      await ctx.plugin(app.plugin)
      expect(ctx.database.type).toBe(config.type)
      const db = app.db
      await db
        .insertInto('records')
        .values([record('a'), record('b', 'two')])
        .execute()
      await db.insertInto('labels').values({ id: 'l', record_id: 'a', title: '标签' }).execute()
      const rows = await db
        .selectFrom('records')
        .selectAll()
        .where('workspace_id', '=', 'one')
        .execute()
      expect(rows).toEqual([record('a')])
      expect(values.readJson(rows[0]!.payload)).toEqual({ key: 'a', unicode: '中文' })
      expect(values.readTimestamp(rows[0]!.created_at).toISOString()).toBe(
        '2026-09-11T00:00:00.000Z',
      )
      expect(values.readBoolean(rows[0]!.enabled)).toBe(true)
      const joined = await db
        .selectFrom('records as r')
        .innerJoin('labels as l', 'r.id', 'l.record_id')
        .select(['r.id', 'l.title'])
        .execute()
      expect(joined).toEqual([{ id: 'a', title: '标签' }])
      expect(
        await db
          .selectFrom('records')
          .innerJoin('labels', 'records.id', 'labels.record_id')
          .select('records.id')
          .execute(),
      ).toEqual([{ id: 'a' }])
      const subquery = db.selectFrom('labels').select(['record_id', 'title']).as('label')
      expect(
        await db
          .selectFrom('records')
          .innerJoin(subquery, 'label.record_id', 'records.id')
          .select(['records.id', 'label.title'])
          .execute(),
      ).toEqual([{ id: 'a', title: '标签' }])
      expect(
        await db
          .selectFrom('records as r')
          .select('r.id')
          .where((eb) =>
            eb.exists(
              eb.selectFrom('labels as l').select('l.id').whereRef('l.record_id', '=', 'r.id'),
            ),
          )
          .execute(),
      ).toEqual([{ id: 'a' }])
      expect(
        await db.selectFrom('records').select('id').orderBy('id').limit(1).offset(1).execute(),
      ).toEqual([{ id: 'b' }])
      expect(
        await db
          .selectFrom('records')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .executeTakeFirstOrThrow(),
      ).toEqual({ count: 2 })
      await db.updateTable('records').set({ enabled: 0 }).where('id', '=', 'a').execute()
      expect(
        (
          await db
            .selectFrom('records')
            .select('enabled')
            .where('id', '=', 'a')
            .executeTakeFirstOrThrow()
        ).enabled,
      ).toBe(0)
      await db.deleteFrom('records').where('id', '=', 'b').execute()
      expect(await db.selectFrom('records').select('id').execute()).toEqual([{ id: 'a' }])
      await expect(
        db
          .insertInto('records')
          .values({ ...record('c'), enabled: 3 })
          .execute(),
      ).rejects.toThrow()
      await expect(
        db
          .insertInto('records')
          .values({ ...record('c'), title: '长'.repeat(101) })
          .execute(),
      ).rejects.toThrow()
    })

    it('事务提交、异常回滚及事务结束后旧入口拒绝访问', async () => {
      const { ctx } = await setup(config)
      const app = consumer(id())
      await ctx.plugin(app.plugin)
      let old: Queries<Tables> | undefined
      await app.db.transaction(async (trx) => {
        old = trx
        await trx.insertInto('records').values(record()).execute()
      })
      await expect(
        app.db.transaction(async (trx) => {
          await trx.insertInto('records').values(record('b')).execute()
          throw new Error('回滚')
        }),
      ).rejects.toThrow('回滚')
      expect(await app.db.selectFrom('records').select('id').execute()).toEqual([{ id: 'a' }])
      expect(() => old!.selectFrom('records')).toThrow('事务已结束')
    })

    it('同插件多实例共享表，卸载保留数据，不同插件同名表独立', async () => {
      const { ctx } = await setup(config)
      const pluginId = id()
      const first = consumer(pluginId)
      const second = consumer(pluginId)
      const other = consumer(id())
      const fiber = await ctx.plugin(first.plugin)
      await ctx.plugin(second.plugin)
      await ctx.plugin(other.plugin)
      await first.db.insertInto('records').values(record()).execute()
      const stale = first.db.selectFrom('records').selectAll()
      await fiber.dispose()
      expect(() => first.db.insertInto('records')).toThrow()
      await expect(stale.execute()).rejects.toThrow()
      expect(await second.db.selectFrom('records').select('id').execute()).toEqual([{ id: 'a' }])
      expect(await other.db.selectFrom('records').selectAll().execute()).toEqual([])
      await ctx.plugin(first.plugin)
      expect(await first.db.selectFrom('records').select('id').execute()).toEqual([{ id: 'a' }])
    })

    it('校验历史内容、缺失、顺序和代码降级，失败时不执行 apply', async () => {
      const { ctx } = await setup(config)
      const pluginId = id()
      await ctx.plugin(consumer(pluginId).plugin)
      for (const migrations of [
        [initial],
        [upgrade],
        [upgrade, initial],
        [
          {
            ...initial,
            steps: [...initial.steps, { kind: 'dropTable' as const, table: 'labels' }],
          },
          upgrade,
        ],
      ]) {
        const app = consumer(pluginId, migrations)
        await expect(ctx.plugin(app.plugin)).rejects.toThrow()
        expect(app.starts).toBe(0)
      }
      // 对象键排列变化不会改变迁移校验和。
      const reordered = { steps: initial.steps, id: initial.id }
      await ctx.plugin(consumer(pluginId, [reordered, upgrade]).plugin)
    })

    it('部分 DDL 失败：事务库回滚，MySQL 阻止自动重试', async () => {
      const { ctx } = await setup(config)
      const pluginId = id()
      const broken = defineMigration({
        id: '001_bad',
        steps: [
          { kind: 'createTable', table: 'partial', columns: [{ name: 'value', type: 'text' }] },
          { kind: 'dropTable', table: 'missing' },
        ],
      })
      const app = consumer(pluginId, [broken])
      await expect(ctx.plugin(app.plugin)).rejects.toThrow('迁移失败')
      expect(app.starts).toBe(0)
      const fixed = consumer(pluginId, [{ ...broken, steps: broken.steps.slice(0, 1) }])
      if (config.type === 'mysql') {
        await expect(ctx.plugin(fixed.plugin)).rejects.toThrow('人工恢复')
        expect(fixed.starts).toBe(0)
      } else {
        await ctx.plugin(fixed.plugin)
        expect(fixed.starts).toBe(1)
      }
    })

    it('后端卸载与恢复触发消费者重启，拒绝重复注册及旧入口', async () => {
      const { ctx, backend } = await setup(config)
      const app = consumer(id())
      const fiber = await ctx.plugin(app.plugin)
      const old = app.db
      const duplicate = { ...implementation }
      await expect(ctx.plugin(duplicate, config)).rejects.toThrow('启动失败')
      await backend.dispose()
      expect(() => old.selectFrom('records')).toThrow()
      await ctx.plugin(implementation, config)
      await fiber.await()
      expect(app.starts).toBe(2)
      await app.db.selectFrom('records').selectAll().execute()
    })

    it('关闭后端等待在途事务回滚后释放连接', async () => {
      const { ctx, backend } = await setup(config)
      const app = consumer(id())
      await ctx.plugin(app.plugin)
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })
      const transaction = app.db.transaction(async (trx) => {
        await trx.insertInto('records').values(record()).execute()
        entered()
        await resume
      })
      const rejected = expect(transaction).rejects.toThrow()
      await started
      let closed = false
      const closing = backend.dispose().then(() => {
        closed = true
      })
      try {
        await expect
          .poll(() => {
            try {
              app.db.selectFrom('records')
              return false
            } catch {
              return true
            }
          })
          .toBe(true)
        expect(closed).toBe(false)
      } finally {
        release()
      }
      await rejected
      await closing
    })

    it('定义服务卸载后恢复，后端与消费者都重新就绪', async () => {
      const { ctx, definition, backend } = await setup(config)
      const app = consumer(id())
      const fiber = await ctx.plugin(app.plugin)
      const old = app.db
      await definition.dispose()
      expect(() => old.selectFrom('records')).toThrow()
      await ctx.plugin(DatabaseProvider)
      await backend.await()
      await fiber.await()
      expect(app.starts).toBe(2)
      await app.db.selectFrom('records').selectAll().execute()
    })

    it('保留其他注入依赖，依赖恢复后新作用域可用而旧作用域失效', async () => {
      const { ctx } = await setup(config)
      const dependency = await ctx.plugin(TestRegistry)
      const app = consumer(id(), [initial], ['testRegistry'])
      const fiber = await ctx.plugin(app.plugin)
      const old = app.db
      await dependency.dispose()
      expect(() => old.selectFrom('records')).toThrow()
      await ctx.plugin(TestRegistry)
      await fiber.await()
      expect(app.starts).toBe(2)
      await app.db.selectFrom('records').selectAll().execute()
      expect(() => old.selectFrom('records')).toThrow()
    })

    it('不同进程并发执行同一迁移，仅创建一套表和历史', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'antarestra-database-'))
      directories.push(directory)
      const shared =
        config.type === 'sqlite'
          ? { ...config, filename: join(directory, 'concurrent.sqlite') }
          : config
      const pluginId = id()
      const worker = () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--conditions=development',
              '--import',
              'tsx',
              fileURLToPath(new URL('../fixtures/database-worker.ts', import.meta.url)),
            ],
            {
              env: {
                ...process.env,
                ANTARESTRA_TEST_CONFIG: JSON.stringify(shared),
                ANTARESTRA_TEST_PLUGIN: pluginId,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            },
          )
          let output = ''
          child.stdout.on('data', (chunk) => {
            output += String(chunk)
          })
          child.stderr.on('data', () => {})
          const timeout = setTimeout(() => {
            child.kill()
            reject(new Error('迁移进程超时'))
          }, 45_000)
          child.on('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          child.on('close', (code) => {
            clearTimeout(timeout)
            if (code === 0 && output.includes('迁移完成')) resolve()
            else reject(new Error(`迁移进程失败：${code}`))
          })
        })
      const results = await Promise.allSettled([worker(), worker(), worker()])
      for (const result of results) if (result.status === 'rejected') throw result.reason
      const { ctx } = await setup(shared)
      await ctx.plugin(consumer(pluginId, [initial]).plugin)
    }, 60_000)

    it.skipIf(config.type !== 'mysql')(
      '迁移进程被终止后保留 running 状态并阻止业务启动',
      async () => {
        const { ctx } = await setup(config)
        const pluginId = id()
        const child = spawn(
          process.execPath,
          [
            '--conditions=development',
            '--import',
            'tsx',
            fileURLToPath(new URL('../fixtures/database-worker.ts', import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              ANTARESTRA_TEST_CONFIG: JSON.stringify(config),
              ANTARESTRA_TEST_PLUGIN: pluginId,
              ANTARESTRA_TEST_INTERRUPT: '1',
            },
            stdio: 'ignore',
            windowsHide: true,
          },
        )
        const exited = new Promise<void>((resolve, reject) => {
          child.on('error', reject)
          child.on('close', () => resolve())
        })
        const db = ctx.database.scope<{ part_0: { value: string } }>(ctx, pluginId)
        try {
          await expect
            .poll(
              async () => {
                try {
                  await db.selectFrom('part_0').selectAll().execute()
                  return true
                } catch {
                  return false
                }
              },
              { timeout: 10_000, interval: 10 },
            )
            .toBe(true)
        } finally {
          child.kill('SIGKILL')
          await exited
        }
        const app = consumer(pluginId, [interrupted])
        await expect(ctx.plugin(app.plugin)).rejects.toThrow('running')
        expect(app.starts).toBe(0)
      },
      15_000,
    )
  })
}

describe('database 声明与配置校验', () => {
  it('非法迁移在执行任何 DDL 之前被拒绝', async () => {
    const { ctx } = await setup({ filename: ':memory:' })
    const pluginId = id()
    const invalid = defineMigration({
      id: '002_bad',
      steps: [
        { kind: 'createTable', table: 'invalid-name', columns: [{ name: 'value', type: 'text' }] },
      ],
    })
    await expect(ctx.database.migrate(ctx, pluginId, [initial, invalid])).rejects.toThrow(
      '逻辑标识',
    )
    const app = consumer(pluginId)
    await ctx.plugin(app.plugin)
    await expect(app.db.selectFrom('records').selectAll().execute()).resolves.toEqual([])
    expect(() => ctx.database.scope(ctx, 'Bad Plugin')).toThrow('插件标识')
    expect(() => values.readBoolean(2)).toThrow()
    expect(() => values.readTimestamp(Number.NaN)).toThrow()
  })

  it('网络连接串必须显式配置且拒绝无效值', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(DatabaseProvider)
    await expect(ctx.plugin({ ...implementation }, { type: 'mysql' })).rejects.toThrow('url')
    await expect(ctx.plugin({ ...implementation }, { filename: '' })).rejects.toThrow('文件名')
    await expect(
      ctx.plugin({ ...implementation }, { type: 'postgresql', url: 'invalid-secret' }),
    ).rejects.toThrow('连接串格式无效')
  })
})
