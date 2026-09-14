import type { Context } from '@antarestra/plugin-sdk'
import type {
  DatabaseBackend,
  DatabaseScope,
  DatabaseTransaction,
  DatabaseType,
  Migration,
} from '@antarestra/database'
import { Kysely, sql } from 'kysely'
import type { Dialect } from 'kysely'
import { createDialect, managedDialect, parseConfig } from './connection.js'
import type { Config } from './connection.js'
import { queryPlugin, queries } from './query.js'
import { pluginName } from './names.js'
import { migrate } from './migration.js'

export type { Config } from './connection.js'
export const name = 'database-kysely'
export const inject = ['databaseProvider']

class Backend implements DatabaseBackend {
  private active = true
  private readonly db: Kysely<object>
  private queue: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private readonly owners = new WeakMap<Context, () => void>()

  constructor(
    readonly type: DatabaseType,
    dialect: Dialect,
  ) {
    this.db = new Kysely({ dialect: managedDialect(dialect, () => this.assertActive()) })
  }

  private assertActive(): void {
    if (!this.active) throw new Error('数据库连接已关闭')
  }

  private guard(ctx: Context): () => void {
    this.assertActive()
    ctx.fiber.assertActive()
    let guard = this.owners.get(ctx)
    if (!guard) {
      let active = true
      ctx.effect(() => () => {
        active = false
        this.owners.delete(ctx)
      })
      guard = () => {
        this.assertActive()
        if (!active) throw new Error('数据库查询所属插件已卸载')
        ctx.fiber.assertActive()
      }
      this.owners.set(ctx, guard)
    }
    return guard
  }

  async initialize(): Promise<void> {
    await sql`select 1`.execute(this.db)
  }

  scope<Tables>(ctx: Context, pluginId: string): DatabaseScope<Tables> {
    pluginName(pluginId)
    const guard = this.guard(ctx)
    // Kysely 的泛型仅描述查询表类型，不生成运行时模型；边界由命名空间与迁移校验保护。
    const db = this.db.withPlugin(queryPlugin(pluginId, guard)) as unknown as Kysely<Tables>
    return {
      ...queries(db, guard),
      transaction: (callback) => {
        guard()
        return this.db.transaction().execute(async (trx) => {
          let active = true
          const transactionGuard = () => {
            guard()
            if (!active) throw new Error('数据库事务已结束')
          }
          const scoped = trx.withPlugin(
            queryPlugin(pluginId, transactionGuard),
          ) as unknown as Kysely<Tables>
          try {
            transactionGuard()
            const result = await callback(queries(scoped, transactionGuard))
            transactionGuard()
            return result
          } finally {
            active = false
          }
        })
      },
    }
  }

  async migrate(ctx: Context, pluginId: string, migrations: readonly Migration[]): Promise<void> {
    const guard = this.guard(ctx)
    const snapshot = structuredClone(migrations)
    const pending = this.queue.then(() => migrate(this.db, this.type, pluginId, snapshot, guard))
    this.queue = pending.catch(() => {})
    await pending
  }

  transaction<T>(
    ctx: Context,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const ownerGuard = this.guard(ctx)
    return this.db.transaction().execute(async (trx) => {
      let active = true
      const guards = new Set([ownerGuard])
      const assertActive = () => {
        if (!active) throw new Error('数据库事务已结束')
        for (const guard of guards) guard()
      }
      try {
        assertActive()
        const result = await callback({
          scope: <Tables>(owner: Context, pluginId: string) => {
            assertActive()
            pluginName(pluginId)
            guards.add(this.guard(owner))
            const scoped = trx.withPlugin(
              queryPlugin(pluginId, assertActive),
            ) as unknown as Kysely<Tables>
            return queries(scoped, assertActive)
          },
        })
        assertActive()
        return result
      } finally {
        active = false
      }
    })
  }

  close(): Promise<void> {
    return (this.closing ??= this.shutdown())
  }

  private async shutdown(): Promise<void> {
    this.active = false
    await this.queue
    await this.db.destroy()
  }
}

export async function apply(ctx: Context, input: Config = {}): Promise<void> {
  const config = parseConfig(input)
  const dialect = await createDialect(config, () => {
    ctx.logger('database').error('数据库连接异常，正在撤销数据库服务')
    void ctx.fiber.dispose().catch(() => ctx.logger('database').error('数据库资源回收失败'))
  })
  const backend = new Backend(config.type, dialect)
  ctx.effect(() => () => backend.close())
  try {
    await backend.initialize()
    await ctx.databaseProvider.register(ctx, backend)
  } catch {
    await backend.close()
    throw new Error('数据库插件启动失败，请检查连接配置或重复的后端注册')
  }
}
