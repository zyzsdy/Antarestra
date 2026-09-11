import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import type { Kysely } from 'kysely'
import type { Migration } from './schema.js'

export * from './schema.js'
export type { ColumnType as KyselyColumnType, Insertable, Selectable, Updateable } from 'kysely'

export type DatabaseType = 'sqlite' | 'postgresql' | 'mysql'
export type Queries<Tables> = Pick<
  Kysely<Tables>,
  'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
>
export type DatabaseScope<Tables> = Queries<Tables> & {
  transaction<T>(callback: (db: Queries<Tables>) => Promise<T>): Promise<T>
}

export interface DatabaseBackend {
  readonly type: DatabaseType
  scope<Tables>(ctx: Context, pluginId: string): DatabaseScope<Tables>
  migrate(ctx: Context, pluginId: string, migrations: readonly Migration[]): Promise<void>
}

declare module '@antarestra/plugin-sdk' {
  interface Context {
    database: DatabaseService
    databaseProvider: DatabaseProvider
  }
}

/** 仅在后端完成连接后发布，消费者可用 inject 等待真正就绪。 */
export class DatabaseService extends Service<DatabaseBackend> {
  private active = true

  constructor(
    ctx: Context,
    private readonly backend: DatabaseBackend,
  ) {
    super(ctx, 'database')
    ctx.effect(() => () => {
      this.active = false
    })
  }

  get type(): DatabaseType {
    return this.backend.type
  }

  scope<Tables>(ctx: Context, pluginId: string): DatabaseScope<Tables> {
    this.assertActive()
    return this.backend.scope<Tables>(ctx, pluginId)
  }

  async migrate(ctx: Context, pluginId: string, migrations: readonly Migration[]): Promise<void> {
    this.assertActive()
    await this.backend.migrate(ctx, pluginId, migrations)
  }

  private assertActive(): void {
    if (!this.active) throw new Error('数据库服务已卸载')
  }
}

/** 定义插件负责后端登记，连接池和 database 服务归属于实现插件。 */
export class DatabaseProvider extends Service {
  private owner: object | undefined

  constructor(ctx: Context) {
    super(ctx, 'databaseProvider')
  }

  async register(ctx: Context, backend: DatabaseBackend): Promise<void> {
    this.ctx.fiber.assertActive()
    if (this.owner) throw new Error('数据库后端重复注册')
    const token = {}
    const release = ctx.effect(() => {
      this.owner = token
      return () => {
        if (this.owner === token) this.owner = undefined
      }
    })
    try {
      await ctx.plugin(DatabaseService, backend)
    } catch (error) {
      await release()
      throw error
    }
  }
}

export function defineDatabasePlugin<Config>(options: {
  name: string
  migrations: readonly Migration[]
  inject?: readonly string[]
  apply: (ctx: Context, config: Config) => void | Promise<void>
}) {
  const migrations = structuredClone(options.migrations)
  const name = options.name
  const apply = options.apply
  return {
    name,
    inject: [...new Set(['database', ...(options.inject ?? [])])],
    async apply(ctx: Context, config: Config): Promise<void> {
      await ctx.database.migrate(ctx, name, migrations)
      ctx.fiber.assertActive()
      await apply(ctx, config)
    },
  }
}

export default DatabaseProvider
