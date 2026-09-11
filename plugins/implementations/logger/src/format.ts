import { Logger } from '@antarestra/plugin-sdk'
import type { Message } from '@antarestra/plugin-sdk'
import { inspect, stripVTControlCharacters } from 'node:util'

const pad = (value: number) => String(value).padStart(2, '0')

export function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatMessage(message: Message, label = `[${message.name}]`): string {
  const date = new Date(message.ts)
  const time = `${localDate(message.ts)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  let content: string
  try {
    content = Logger.format({ colors: false, maxLength: Infinity, export() {} }, message)
  } catch {
    // 循环对象等无法被 Cordis 默认 JSON formatter 序列化时，日志不能击穿业务调用。
    content = message.args
      .map((value: unknown) =>
        typeof value === 'string'
          ? value
          : inspect(value, { depth: 4, customInspect: false, getters: false }),
      )
      .join(' ')
  }
  const prefix = `[${message.type}] ${time} ${label}`
  return stripVTControlCharacters(content)
    .split(/\r\n|\r|\n/)
    .map((line) => `${prefix} ${line}\n`)
    .join('')
}

export function cleanName(name: string): string {
  return stripVTControlCharacters(name).replace(/[\r\n]/g, ' ')
}
