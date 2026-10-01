const pad = (value: number) => String(value).padStart(2, '0')

export function formatActivityTime(timestamp: number, now = new Date()) {
  const date = new Date(timestamp)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.getFullYear() !== now.getFullYear()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (timestamp >= today.getTime() && timestamp <= now.getTime()) {
    const minutes = Math.floor((now.getTime() - timestamp) / 60_000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    return `${Math.floor(minutes / 60)}小时前`
  }
  if (timestamp >= yesterday.getTime() && timestamp < today.getTime()) {
    return `昨天 ${date.getHours()}:${pad(date.getMinutes())}`
  }
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`
}

export function formatMessageTime(timestamp: number, now = new Date()) {
  const date = new Date(timestamp)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const beforeYesterday = new Date(today)
  beforeYesterday.setDate(today.getDate() - 2)
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  if (day === today.getTime()) return time
  if (day === yesterday.getTime()) return `昨天 ${time}`
  if (day >= monday.getTime() && day < today.getTime() && day !== beforeYesterday.getTime())
    return `周${'日一二三四五六'[date.getDay()]} ${time}`
  if (date.getFullYear() === now.getFullYear()) {
    if (date.getMonth() === now.getMonth()) return `${date.getDate()}日 ${time}`
    return `${date.getMonth() + 1}-${date.getDate()} ${time}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}
