export type ColumnType = 'string' | 'text' | 'integer' | 'float' | 'boolean' | 'timestamp' | 'json'

export interface Column {
  name: string
  type: ColumnType
  length?: number
  primaryKey?: boolean
  notNull?: boolean
  default?: string | number | null
}

export type SchemaStep =
  | { kind: 'createFullTextIndex'; table: string; name: string; column: string }
  | { kind: 'createTable'; table: string; columns: readonly Column[] }
  | { kind: 'dropTable'; table: string }
  | { kind: 'addColumn'; table: string; column: Column }
  | { kind: 'renameColumn'; table: string; from: string; to: string }
  | { kind: 'dropColumn'; table: string; column: string }
  | {
      kind: 'createIndex'
      table: string
      name: string
      columns: readonly string[]
      unique?: boolean
    }
  | { kind: 'dropIndex'; table: string; name: string }

export interface Migration {
  readonly id: string
  readonly steps: readonly SchemaStep[]
}

export function defineMigration(migration: Migration): Migration {
  // 防止声明之后被原对象修改；执行端另行进行严格运行时校验与规范化。
  return structuredClone(migration)
}

export const values = {
  integer(value: number): number {
    if (!Number.isSafeInteger(value)) throw new TypeError('整数必须在 JavaScript 安全范围内')
    return value
  },
  boolean(value: boolean): 0 | 1 {
    if (typeof value !== 'boolean') throw new TypeError('布尔值必须是 boolean')
    return value ? 1 : 0
  },
  readBoolean(value: number): boolean {
    if (value !== 0 && value !== 1) throw new TypeError('布尔存储值必须是 0 或 1')
    return value === 1
  },
  timestamp(value: Date): number {
    const result = value.getTime()
    if (!Number.isSafeInteger(result)) throw new TypeError('时间必须是有效的 UTC 毫秒整数')
    return result
  },
  readTimestamp(value: number): Date {
    if (!Number.isSafeInteger(value) || Number.isNaN(new Date(value).getTime())) {
      throw new TypeError('时间必须是有效的 UTC 毫秒整数')
    }
    return new Date(value)
  },
  json(value: unknown): string {
    const result = JSON.stringify(value)
    if (result === undefined) throw new TypeError('值不能序列化为 JSON')
    return result
  },
  readJson(value: string): unknown {
    return JSON.parse(value) as unknown
  },
}
