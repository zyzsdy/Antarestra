import { describe, expect, it } from 'vitest'
import {
  formatActivityTime,
  formatMessageTime,
} from '../../plugins/features/chat-webui/client/message-time.js'

describe('对话上次活动时间', () => {
  const now = new Date(2026, 9, 2, 18)
  it.each([
    [new Date(2026, 9, 2, 17, 59, 59), '刚刚'],
    [new Date(2026, 9, 2, 17, 59), '1分钟前'],
    [new Date(2026, 9, 2, 17, 1), '59分钟前'],
    [new Date(2026, 9, 2, 17), '1小时前'],
    [new Date(2026, 9, 1, 6, 35), '昨天 6:35'],
    [new Date(2026, 8, 30, 16, 4), '9-30 16:04'],
    [new Date(2026, 6, 13, 16, 4), '7-13 16:04'],
    [new Date(2025, 6, 13, 6, 4), '2025-07-13 06:04'],
  ])('格式化 %s', (date, expected) => {
    expect(formatActivityTime(date.getTime(), now)).toBe(expected)
  })
  it('按本地日历区分昨天，跨年优先显示完整日期', () => {
    expect(
      formatActivityTime(new Date(2026, 8, 30, 23, 59).getTime(), new Date(2026, 9, 1, 0, 1)),
    ).toBe('昨天 23:59')
    expect(
      formatActivityTime(new Date(2025, 11, 31, 23, 59).getTime(), new Date(2026, 0, 1, 0, 1)),
    ).toBe('2025-12-31 23:59')
  })
})

describe('消息自然时间', () => {
  const now = new Date(2026, 8, 25, 18)
  it.each([
    [new Date(2026, 8, 25, 6, 48), '06:48'],
    [new Date(2026, 8, 24, 6, 48), '昨天 06:48'],
    [new Date(2026, 8, 23, 12, 9), '23日 12:09'],
    [new Date(2026, 8, 21, 16, 15), '周一 16:15'],
    [new Date(2026, 8, 20, 12, 9), '20日 12:09'],
    [new Date(2026, 8, 9, 12, 9), '9日 12:09'],
    [new Date(2026, 6, 13, 1, 24), '7-13 01:24'],
    [new Date(2025, 7, 23, 4, 56), '2025-08-23 04:56'],
  ])('格式化 %s', (date, expected) => {
    expect(formatMessageTime(date.getTime(), now)).toBe(expected)
  })
  it('昨天跨月跨年仍优先，跨年其他日期显示完整日期', () => {
    const today = new Date(2026, 0, 1, 0, 1)
    expect(formatMessageTime(new Date(2025, 11, 31, 23, 59).getTime(), today)).toBe('昨天 23:59')
    expect(formatMessageTime(new Date(2025, 11, 30, 4, 56).getTime(), today)).toBe(
      '2025-12-30 04:56',
    )
  })
})
