import { createHash } from 'node:crypto'

export function pluginName(id: string): string {
  if (typeof id !== 'string' || !/^[a-z0-9@][a-z0-9@/._-]{0,127}$/.test(id)) {
    throw new Error('插件标识必须是最多 128 字符的小写包名或稳定标识')
  }
  return id
}

export function identifier(name: string): string {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
    throw new Error('数据库逻辑标识必须为小写字母开头的 1–32 位字母、数字或下划线')
  }
  return name
}

export function namespace(pluginId: string): string {
  return `p_${createHash('sha256').update(pluginName(pluginId)).digest('hex').slice(0, 20)}`
}

export function physicalName(pluginId: string, name: string): string {
  return `${namespace(pluginId)}_${identifier(name)}`
}
