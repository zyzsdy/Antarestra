import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DatabaseType, Migration } from '@antarestra/database'
import { namespace, pluginName } from './names.js'
import { migrations } from './validation.js'
import { applyStep } from './schema.js'

type History = {
  plugin_id: string
  migration_id: string
  checksum: string
  status: 'running' | 'applied' | 'failed'
  applied_at: number
}
type Metadata = {
  antarestra_migrations: History
  antarestra_namespaces: { plugin_id: string; prefix: string }
}

async function initialize(db: Kysely<Metadata>): Promise<void> {
  await db.schema
    .createTable('antarestra_namespaces')
    .ifNotExists()
    .addColumn('plugin_id', 'varchar(128)', (c) => c.primaryKey())
    .addColumn('prefix', 'varchar(24)', (c) => c.notNull().unique())
    .execute()
  await db.schema
    .createTable('antarestra_migrations')
    .ifNotExists()
    .addColumn('plugin_id', 'varchar(128)', (c) => c.notNull())
    .addColumn('migration_id', 'varchar(128)', (c) => c.notNull())
    .addColumn('checksum', 'varchar(64)', (c) => c.notNull())
    .addColumn('status', 'varchar(16)', (c) => c.notNull())
    .addColumn('applied_at', 'bigint', (c) => c.notNull())
    .addPrimaryKeyConstraint('antarestra_migrations_pk', ['plugin_id', 'migration_id'])
    .execute()
}

async function execute(
  db: Kysely<Metadata>,
  type: DatabaseType,
  pluginId: string,
  input: ReturnType<typeof migrations>,
  assertActive: () => void,
): Promise<void> {
  assertActive()
  await initialize(db)
  const prefix = namespace(pluginId)
  const existing = await db
    .selectFrom('antarestra_namespaces')
    .selectAll()
    .where('prefix', '=', prefix)
    .executeTakeFirst()
  if (existing && existing.plugin_id !== pluginId) throw new Error('插件数据库命名空间哈希冲突')
  if (!existing)
    await db.insertInto('antarestra_namespaces').values({ plugin_id: pluginId, prefix }).execute()
  const history = await db
    .selectFrom('antarestra_migrations')
    .selectAll()
    .where('plugin_id', '=', pluginId)
    .orderBy('migration_id')
    .execute()
  for (const [index, row] of history.entries()) {
    const expected = input[index]
    if (row.status !== 'applied')
      throw new Error(`迁移需要人工恢复：${pluginId}/${row.migration_id} (${row.status})`)
    if (!expected || expected.id !== row.migration_id || expected.checksum !== row.checksum) {
      throw new Error(
        `迁移历史不兼容：${pluginId}/${row.migration_id}，历史被修改、缺失或代码已降级`,
      )
    }
  }
  for (const item of input.slice(history.length)) {
    assertActive()
    await db
      .insertInto('antarestra_migrations')
      .values({
        plugin_id: pluginId,
        migration_id: item.id,
        checksum: item.checksum,
        status: 'running',
        applied_at: Date.now(),
      })
      .execute()
    try {
      for (const step of item.steps) {
        assertActive()
        await applyStep(db, type, pluginId, step)
      }
      assertActive()
      await db
        .updateTable('antarestra_migrations')
        .set({ status: 'applied', applied_at: Date.now() })
        .where('plugin_id', '=', pluginId)
        .where('migration_id', '=', item.id)
        .execute()
    } catch {
      if (type === 'mysql') {
        await db
          .updateTable('antarestra_migrations')
          .set({ status: 'failed' })
          .where('plugin_id', '=', pluginId)
          .where('migration_id', '=', item.id)
          .execute()
      }
      // 驱动错误可能包含数据、SQL 或连接参数，不将其写入日志或上层错误。
      throw new Error(
        `数据库迁移失败：${pluginId}/${item.id}；${type === 'mysql' ? '请检查遗留结构及迁移记录后人工恢复' : '本次迁移事务已回滚'}`,
      )
    }
  }
}

export async function migrate(
  db: Kysely<object>,
  type: DatabaseType,
  pluginId: string,
  input: readonly Migration[],
  assertActive: () => void,
): Promise<void> {
  pluginName(pluginId)
  const checked = migrations(input)
  const metadata = db.$extendTables<Metadata>()
  if (type === 'postgresql') {
    await metadata.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '30s'`.execute(trx)
      await sql`select pg_advisory_xact_lock(1847729141)`.execute(trx)
      await execute(trx, type, pluginId, checked, assertActive)
    })
  } else {
    await metadata.connection().execute(async (connection) => {
      if (type === 'sqlite') {
        // 先拿写锁再读取历史，避免两个进程同时读取后升级事务造成 SQLITE_BUSY。
        await sql`begin immediate`.execute(connection)
        try {
          await execute(connection, type, pluginId, checked, assertActive)
          await sql`commit`.execute(connection)
        } catch (error) {
          await sql`rollback`.execute(connection)
          throw error
        }
      } else {
        const result = await sql<{
          acquired: number | null
        }>`select get_lock('antarestra_migrations_v1', 30) as acquired`.execute(connection)
        if (result.rows[0]?.acquired !== 1) throw new Error('获取数据库迁移锁超时')
        try {
          await execute(connection, type, pluginId, checked, assertActive)
        } finally {
          await sql`select release_lock('antarestra_migrations_v1')`.execute(connection)
        }
      }
    })
  }
}
