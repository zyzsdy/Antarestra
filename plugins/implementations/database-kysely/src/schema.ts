import { sql } from 'kysely'
import type { ColumnDefinitionBuilder, CreateTableBuilder, Kysely, ColumnDataType } from 'kysely'
import type { Column, DatabaseType, SchemaStep } from '@antarestra/database'
import { physicalName } from './names.js'

function dataType(column: Column): ColumnDataType {
  switch (column.type) {
    case 'string':
      return `varchar(${column.length ?? 255})`
    case 'text':
    case 'json':
      return 'text'
    case 'boolean':
      return 'integer'
    case 'integer':
    case 'timestamp':
      return 'bigint'
    case 'float':
      return 'double precision'
  }
}

function decorate(column: Column, type: DatabaseType) {
  return (input: ColumnDefinitionBuilder): ColumnDefinitionBuilder => {
    let builder = input
    if (column.notNull || column.primaryKey) builder = builder.notNull()
    if (column.default !== undefined) {
      const value = sql.lit(column.default)
      builder = builder.defaultTo(
        type === 'mysql' && ['text', 'json'].includes(column.type) ? sql`(${value})` : value,
      )
    }
    const ref = sql.ref(column.name)
    if (column.type === 'integer' || column.type === 'timestamp') {
      builder = builder.check(sql`${ref} between -9007199254740991 and 9007199254740991`)
    } else if (column.type === 'boolean') {
      builder = builder.check(sql`${ref} in (0, 1)`)
    } else if (column.type === 'string') {
      const length = type === 'sqlite' ? sql`length(${ref})` : sql`char_length(${ref})`
      builder = builder.check(sql`${length} <= ${sql.lit(column.length ?? 255)}`)
    }
    return builder
  }
}

export async function applyStep<Tables>(
  db: Kysely<Tables>,
  type: DatabaseType,
  pluginId: string,
  step: SchemaStep,
): Promise<void> {
  const table = physicalName(pluginId, step.table)
  switch (step.kind) {
    case 'createFullTextIndex':
      if (type !== 'postgresql') throw new Error('全文索引需要 PostgreSQL')
      await sql`create index ${sql.id(physicalName(pluginId, step.name))} on ${sql.id(table)} using gin (to_tsvector('simple', ${sql.ref(step.column)}))`.execute(
        db,
      )
      break
    case 'createTable': {
      let builder: CreateTableBuilder<string, string> = db.schema.createTable(table)
      for (const column of step.columns)
        builder = builder.addColumn(column.name, dataType(column), decorate(column, type))
      const primary = step.columns
        .filter((column) => column.primaryKey)
        .map((column) => column.name)
      if (primary.length) builder = builder.addPrimaryKeyConstraint(`${table}_pk`, primary)
      await builder.execute()
      break
    }
    case 'dropTable':
      await db.schema.dropTable(table).execute()
      break
    case 'addColumn':
      await db.schema
        .alterTable(table)
        .addColumn(step.column.name, dataType(step.column), decorate(step.column, type))
        .execute()
      break
    case 'renameColumn':
      await db.schema.alterTable(table).renameColumn(step.from, step.to).execute()
      break
    case 'dropColumn': {
      if (type === 'mysql') {
        // MySQL 不会自动删除引用该列的 CHECK；这些约束由 Portable Schema 自动生成。
        // MariaDB 的列级 CHECK 随列自动删除，且约束名称只在表内唯一。
        const version = await sql<{ version: string }>`select version() as version`.execute(db)
        if (version.rows[0]?.version.includes('MariaDB')) {
          await db.schema.alterTable(table).dropColumn(step.column).execute()
          break
        }
        const checks = await sql<{ name: string; clause: string }>`
          select c.CONSTRAINT_NAME as name, c.CHECK_CLAUSE as clause
          from information_schema.CHECK_CONSTRAINTS c
          inner join information_schema.TABLE_CONSTRAINTS t
            on c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA and c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
          where t.TABLE_SCHEMA = database() and t.TABLE_NAME = ${table} and t.CONSTRAINT_TYPE = 'CHECK'
        `.execute(db)
        const reference = new RegExp(`(^|[^a-z0-9_])${step.column}([^a-z0-9_]|$)`, 'i')
        for (const check of checks.rows) {
          if (reference.test(check.clause))
            await db.schema.alterTable(table).dropConstraint(check.name).execute()
        }
      }
      await db.schema.alterTable(table).dropColumn(step.column).execute()
      break
    }
    case 'createIndex': {
      let builder = db.schema
        .createIndex(physicalName(pluginId, step.name))
        .on(table)
        .columns([...step.columns])
      if (step.unique) builder = builder.unique()
      await builder.execute()
      break
    }
    case 'dropIndex': {
      let builder = db.schema.dropIndex(physicalName(pluginId, step.name))
      if (type === 'mysql') builder = builder.on(table)
      await builder.execute()
      break
    }
  }
}
