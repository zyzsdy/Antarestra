import { createHash } from 'node:crypto'
import type { Column, Migration, SchemaStep } from '@antarestra/database'
import { identifier } from './names.js'

function keys(value: object, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('迁移声明必须是对象')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`迁移声明包含未知字段：${key}`)
  }
}

function flag(value: boolean | undefined): void {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('迁移标记必须是布尔值')
}

function column(value: Column): void {
  keys(value, ['name', 'type', 'length', 'primaryKey', 'notNull', 'default'])
  identifier(value.name)
  if (
    !['string', 'text', 'integer', 'float', 'boolean', 'timestamp', 'json'].includes(value.type)
  ) {
    throw new Error('不支持的字段类型')
  }
  flag(value.primaryKey)
  flag(value.notNull)
  if (value.type === 'string') {
    if (
      value.length !== undefined &&
      (!Number.isInteger(value.length) || value.length < 1 || value.length > 1024)
    ) {
      throw new Error('字符串长度必须在 1–1024 之间')
    }
  } else if (value.length !== undefined) throw new Error('只有 string 可指定 length')
  if (value.primaryKey && value.type !== 'string' && value.type !== 'integer') {
    throw new Error('主键只支持 string 或 integer')
  }
  const d = value.default
  if (d === undefined) return
  if (d === null) {
    if (value.notNull || value.primaryKey) throw new Error('非空字段不能默认 NULL')
    return
  }
  if (['string', 'text', 'json'].includes(value.type)) {
    if (typeof d !== 'string') throw new Error('文本默认值必须是字符串')
    if (value.type === 'string' && [...d].length > (value.length ?? 255))
      throw new Error('默认字符串超长')
    if (value.type === 'json') JSON.parse(d)
  } else {
    if (typeof d !== 'number' || !Number.isFinite(d)) throw new Error('数字默认值必须有限')
    if (value.type !== 'float' && !Number.isSafeInteger(d)) throw new Error('默认值必须是安全整数')
    if (value.type === 'boolean' && d !== 0 && d !== 1) throw new Error('布尔默认值必须为 0 或 1')
  }
}

function step(value: SchemaStep): void {
  if (!value || typeof value !== 'object') throw new Error('迁移步骤必须是对象')
  identifier(value.table)
  switch (value.kind) {
    case 'createTable':
      keys(value, ['kind', 'table', 'columns'])
      if (!Array.isArray(value.columns) || !value.columns.length)
        throw new Error('建表必须声明字段')
      value.columns.forEach(column)
      if (new Set(value.columns.map((c) => c.name)).size !== value.columns.length)
        throw new Error('字段名称重复')
      break
    case 'dropTable':
      keys(value, ['kind', 'table'])
      break
    case 'addColumn':
      keys(value, ['kind', 'table', 'column'])
      column(value.column)
      if (value.column.primaryKey) throw new Error('新增列不支持添加主键')
      break
    case 'renameColumn':
      keys(value, ['kind', 'table', 'from', 'to'])
      identifier(value.from)
      identifier(value.to)
      break
    case 'dropColumn':
      keys(value, ['kind', 'table', 'column'])
      identifier(value.column)
      break
    case 'createIndex':
      keys(value, ['kind', 'table', 'name', 'columns', 'unique'])
      identifier(value.name)
      flag(value.unique)
      if (!Array.isArray(value.columns) || !value.columns.length)
        throw new Error('索引必须声明字段')
      value.columns.forEach(identifier)
      if (new Set(value.columns).size !== value.columns.length) throw new Error('索引字段重复')
      break
    case 'dropIndex':
      keys(value, ['kind', 'table', 'name'])
      identifier(value.name)
      break
    default:
      throw new Error('不支持的迁移操作')
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error('迁移只能包含 JSON 值')
    return text
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}

export function migrations(input: readonly Migration[]): (Migration & { checksum: string })[] {
  if (!Array.isArray(input)) throw new Error('迁移列表必须是数组')
  let previous = ''
  const indexes = new Map<string, string>()
  return input.map((item) => {
    keys(item, ['id', 'steps'])
    if (
      typeof item.id !== 'string' ||
      !/^\d{3,}_[a-z0-9_]+$/.test(item.id) ||
      item.id.length > 128 ||
      item.id <= previous
    ) {
      throw new Error('迁移 ID 必须按字典序严格递增，格式如 001_init，最长 128 字符')
    }
    previous = item.id
    if (!Array.isArray(item.steps) || !item.steps.length) throw new Error('迁移步骤不能为空')
    item.steps.forEach(step)
    for (const operation of item.steps) {
      if (operation.kind === 'createIndex') {
        if (indexes.has(operation.name)) throw new Error('同一插件的索引名称必须唯一')
        indexes.set(operation.name, operation.table)
      } else if (operation.kind === 'dropIndex') indexes.delete(operation.name)
      else if (operation.kind === 'dropTable') {
        for (const [name, table] of indexes) if (table === operation.table) indexes.delete(name)
      }
    }
    const steps = structuredClone(item.steps)
    return {
      id: item.id,
      steps,
      checksum: createHash('sha256').update(canonical(steps)).digest('hex'),
    }
  })
}
