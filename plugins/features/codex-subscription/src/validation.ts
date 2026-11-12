import { AuthError } from '@antarestra/rbac'

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new AuthError(400, message)
}
export function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), '请输入有效对象')
  return value as Record<string, unknown>
}
export function text(value: unknown, label: string, max = 200, empty = false): string {
  check(typeof value === 'string' && value.length <= max && (empty || value.trim()), `${label}无效`)
  return value
}
export function identifier(value: unknown): string {
  const id = text(value, 'ID')
  check(!/[\s\x00-\x1f]/.test(id), 'ID 不能包含空白或控制字符')
  return id
}
