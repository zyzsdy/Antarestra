import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import SQLite from 'better-sqlite3'
import pg from 'pg'
import mysql from 'mysql2'
import { MysqlDialect, PostgresDialect, SqliteDialect } from 'kysely'
import type { Dialect, Driver } from 'kysely'
import type { DatabaseType } from '@antarestra/database'

export interface Config {
  type?: DatabaseType
  filename?: string
  url?: string
}

export function parseConfig(input: Config = {}): Required<Pick<Config, 'type'>> & Config {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('数据库配置必须是对象')
  if (Object.keys(input).some((key) => !['type', 'filename', 'url'].includes(key)))
    throw new Error('数据库配置包含未知字段')
  const type = input.type ?? 'sqlite'
  if (!['sqlite', 'postgresql', 'mysql'].includes(type)) throw new Error('不支持的数据库类型')
  if (type === 'sqlite') {
    if (input.url !== undefined) throw new Error('SQLite 配置不接受 url')
    if (
      input.filename !== undefined &&
      (typeof input.filename !== 'string' || !input.filename.trim())
    )
      throw new Error('SQLite 文件名不能为空')
  } else {
    if (input.filename !== undefined) throw new Error('网络数据库不接受 filename')
    if (typeof input.url !== 'string' || !input.url.trim())
      throw new Error('网络数据库必须提供连接串 url')
  }
  return { ...input, type }
}

function safeInteger(value: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('数据库整数超出 JavaScript 安全范围')
  return result
}

export async function createDialect(
  config: ReturnType<typeof parseConfig>,
  onDisconnect: () => void,
): Promise<Dialect> {
  if (config.type === 'sqlite') {
    const filename =
      config.filename === ':memory:'
        ? ':memory:'
        : resolve(config.filename ?? 'data/antarestra.sqlite')
    if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true })
    return new SqliteDialect({
      database: async () => {
        const database = new SQLite(filename, { timeout: 30_000 })
        try {
          database.pragma('foreign_keys = ON')
          return database
        } catch (error) {
          database.close()
          throw error
        }
      },
    })
  }
  const url = config.url
  if (!url) throw new Error('数据库连接串未设置')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('数据库连接串格式无效')
  }
  if (
    !(config.type === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:']).includes(parsed.protocol)
  )
    throw new Error('数据库连接串协议不匹配')
  if (config.type === 'postgresql') {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 30_000,
      // 只影响本连接池，不修改 pg 的全局类型注册表。
      types: {
        getTypeParser: (oid, format) =>
          oid === 20 && format !== 'binary' ? safeInteger : pg.types.getTypeParser(oid, format),
      },
    })
    pool.on('error', onDisconnect)
    return new PostgresDialect({ pool })
  }
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: 10,
    connectTimeout: 30_000,
    supportBigNumbers: true,
    typeCast(field, next) {
      if (field.type !== 'LONGLONG') return next()
      const value = field.string()
      return value === null ? null : safeInteger(value)
    },
  })
  pool.on('connection', (connection) => connection.on('error', onDisconnect))
  return new MysqlDialect({ pool })
}

/** 关闭时等待已借出的连接，包括仍在执行的事务；拒绝新增借用。 */
export function managedDialect(dialect: Dialect, assertActive: () => void): Dialect {
  return {
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createDriver() {
      const driver = dialect.createDriver()
      let count = 0
      let notify: (() => void) | undefined
      const release = () => {
        if (--count === 0) notify?.()
      }
      return {
        async init(options) {
          try {
            await driver.init(options)
          } catch (error) {
            await driver.destroy()
            throw error
          }
        },
        async acquireConnection(options) {
          assertActive()
          count++
          try {
            return await driver.acquireConnection(options)
          } catch (error) {
            release()
            throw error
          }
        },
        beginTransaction: (connection, settings) => driver.beginTransaction(connection, settings),
        commitTransaction: (connection) => driver.commitTransaction(connection),
        rollbackTransaction: (connection) => driver.rollbackTransaction(connection),
        async releaseConnection(connection, options) {
          try {
            await driver.releaseConnection(connection, options)
          } finally {
            release()
          }
        },
        async destroy(options) {
          if (count)
            await new Promise<void>((resolve) => {
              notify = resolve
            })
          await driver.destroy(options)
        },
      } satisfies Driver
    },
  }
}
