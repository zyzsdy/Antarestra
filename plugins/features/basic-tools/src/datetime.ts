import { AiError } from '@antarestra/ai'
import type { Tool } from '@antarestra/ai'

function parseDatetime(value: unknown): Date {
  if (value === undefined) return new Date()
  const match =
    typeof value === 'string' &&
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(
      value,
    )
  if (!match)
    throw new AiError('invalid_datetime', '日期须为 YYYY-MM-DD，或带 Z / ±HH:mm 的 ISO 日期时间')
  const wallTime = `${match[1]}T${match[2] ?? '00:00:00'}${(match[3] ?? '.').padEnd(4, '0')}Z`
  const wallDate = new Date(wallTime)
  // Date 会将 2 月 30 日等输入自动推进到下个月，需要单独拒绝。
  if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString() !== wallTime)
    throw new AiError('invalid_datetime', '日期或时间不存在')
  return new Date(match[2] ? String(value) : wallTime)
}

export const datetimeTool = {
  id: 'get_datetime',
  description:
    '获取当前日期时间、服务器当前时区和 UTC 日期时间。可传入 datetime 查询指定时刻，或用 timeZone 转换到指定时区。省略 datetime 使用当前时刻；纯日期按 UTC 零点处理，完整日期时间必须带 Z 或 UTC 偏移。返回目标时区的日期时间、该时刻的 UTC 偏移、UTC 时间及毫秒时间戳。',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description:
          '可选：YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss[.SSS]Z / ±HH:mm，例如 2026-10-03T12:30:00+08:00。',
      },
      timeZone: {
        type: 'string',
        description: '可选：目标 IANA 时区，如 Asia/Hong_Kong、America/New_York；默认服务器时区。',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const date = parseDatetime(args.datetime)
    const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (args.timeZone !== undefined && typeof args.timeZone !== 'string')
      throw new AiError('invalid_timezone', 'timeZone 必须是有效的时区名称')
    let formatter: Intl.DateTimeFormat
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: args.timeZone ?? systemTimeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        era: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      })
    } catch {
      throw new AiError('invalid_timezone', 'timeZone 必须是有效的时区名称')
    }
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    )
    const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year)
    const yearText =
      year < 0
        ? `-${String(-year).padStart(6, '0')}`
        : year > 9999
          ? `+${String(year).padStart(6, '0')}`
          : String(year).padStart(4, '0')
    return {
      systemTimeZone,
      timeZone: formatter.resolvedOptions().timeZone,
      localDateTime: `${yearText}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`,
      utcOffset: parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName!.replace('GMT', ''),
      utcDateTime: date.toISOString(),
      timestampMs: date.getTime(),
    }
  },
} satisfies Tool
