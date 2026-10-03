import { afterEach, expect, it, vi } from 'vitest'
import { datetimeTool } from '../../plugins/features/basic-tools/src/datetime.js'

afterEach(() => vi.useRealTimers())

it('无参数查询当前时刻和服务器时区，每次调用重新读取时钟', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-03T04:30:00.123Z'))
  const result = await datetimeTool.execute({})
  expect(result).toMatchObject({
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcDateTime: '2026-10-03T04:30:00.123Z',
    timestampMs: Date.now(),
  })
  vi.setSystemTime(new Date('2026-10-04T00:00:00Z'))
  expect((await datetimeTool.execute({ timeZone: 'UTC' })).localDateTime).toBe(
    '2026-10-04T00:00:00.000',
  )
})

it('指定时刻保留毫秒，目标时区转换可以跨日', async () => {
  expect(
    await datetimeTool.execute({
      datetime: '2026-10-03T00:30:00.125+08:00',
      timeZone: 'Asia/Kathmandu',
    }),
  ).toMatchObject({
    localDateTime: '2026-10-02T22:15:00.125',
    utcOffset: '+05:45',
    utcDateTime: '2026-10-02T16:30:00.125Z',
    timestampMs: Date.parse('2026-10-02T16:30:00.125Z'),
  })
})

it.each([
  ['2026-03-08T06:59:59Z', '2026-03-08T01:59:59.000', '-05:00'],
  ['2026-03-08T07:00:00Z', '2026-03-08T03:00:00.000', '-04:00'],
  ['2026-11-01T05:30:00Z', '2026-11-01T01:30:00.000', '-04:00'],
  ['2026-11-01T06:30:00Z', '2026-11-01T01:30:00.000', '-05:00'],
])('按指定时刻应用夏令时：%s', async (datetime, localDateTime, utcOffset) => {
  expect(await datetimeTool.execute({ datetime, timeZone: 'America/New_York' })).toMatchObject({
    localDateTime,
    utcOffset,
  })
})

it.each([
  ['2024-02-29', '2024-02-29T00:00:00.000Z'],
  ['2000-02-29T23:59:59.1-03:30', '2000-03-01T03:29:59.100Z'],
  ['0099-01-01', '0099-01-01T00:00:00.000Z'],
  ['0000-01-01', '0000-01-01T00:00:00.000Z'],
])('支持有效闰日、纯日期和早期年份：%s', async (datetime, utcDateTime) => {
  expect(await datetimeTool.execute({ datetime, timeZone: 'UTC' })).toMatchObject({
    localDateTime: utcDateTime.slice(0, -1),
    utcDateTime,
    utcOffset: '+00:00',
  })
})

it.each([
  '',
  '明天',
  '2026-02-29',
  '1900-02-29',
  '2026-04-31T00:00:00Z',
  '2026-13-01',
  '2026-10-03T12:30:00',
  '2026-10-03T24:00:00Z',
  '2026-10-03T12:30:60Z',
  '2026-10-03T12:30:00+24:00',
  '2026-10-03T12:30:00+08:60',
  '2026-10-03T12:30:00.1234Z',
  null,
  0,
])('拒绝无效或含糊日期时间：%s', async (datetime) => {
  await expect(datetimeTool.execute({ datetime })).rejects.toMatchObject({
    code: 'invalid_datetime',
  })
})

it.each(['', 'Mars/Olympus', null, 8])('拒绝无效时区：%s', async (timeZone) => {
  await expect(datetimeTool.execute({ timeZone })).rejects.toMatchObject({
    code: 'invalid_timezone',
  })
})
