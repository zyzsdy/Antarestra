import { AiError } from '@antarestra/ai'
import type { JsonObject } from '@antarestra/ai'

export function schedule(args: JsonObject, now = Date.now()) {
  if (
    typeof args.triggerAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(args.triggerAt)
  )
    throw new AiError('invalid_schedule', 'triggerAt 必须是包含时区的 ISO 8601 时间')
  const at = Date.parse(args.triggerAt)
  const day = args.triggerAt.slice(0, 10)
  if (
    !Number.isFinite(at) ||
    at <= now ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw new AiError('invalid_schedule', '触发时间必须是有效的未来时间')
  const mode = args.mode ?? 'once'
  if (mode !== 'once' && mode !== 'interval') throw new AiError('invalid_schedule', '未知触发类型')
  if (mode === 'once' && args.intervalSeconds !== undefined)
    throw new AiError('invalid_schedule', '一次性任务不能设置周期')
  const seconds = args.intervalSeconds
  if (
    mode === 'interval' &&
    (typeof seconds !== 'number' ||
      !Number.isSafeInteger(seconds) ||
      seconds < 60 ||
      seconds > 31536000)
  )
    throw new AiError('invalid_schedule', '周期必须是 60 至 31536000 的整数秒数')
  for (const [key, max] of [
    ['reason', 2000],
    ['prompt', 100000],
  ] as const) {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
      throw new AiError('invalid_schedule', `${key} 必须是非空文本且长度不超过 ${max}`)
  }
  return {
    at,
    interval: mode === 'interval' ? (seconds as number) * 1000 : null,
    reason: args.reason as string,
    prompt: args.prompt as string,
  }
}

export function nextOccurrence(at: number, interval: number, now: number) {
  return at + Math.max(1, Math.floor((now - at) / interval) + 1) * interval
}
