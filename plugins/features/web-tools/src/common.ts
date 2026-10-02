import { createHash } from 'node:crypto'
import type { Json, JsonObject, StructuredToolResult } from '@antarestra/ai'

export interface Config {
  apiKey?: string
  searchProxy?: string
  timeoutMs?: number
  idleMinutes?: number
  maxSessions?: number
  maxPages?: number
  maxCharacters?: number
}
export class WebError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function errorResult(error: unknown): StructuredToolResult {
  if (error instanceof Error && /timeout/i.test(error.name))
    return {
      isError: true,
      content: {
        error: 'operation_timeout',
        message: '操作超时，操作是否生效可能无法确定；请先读取页面，不要直接重复提交',
      },
    }
  return {
    isError: true,
    content: {
      error: error instanceof WebError ? error.code : 'operation_failed',
      message: error instanceof WebError ? error.message : '网页操作失败，请重新读取页面后重试',
    },
  }
}
export function urlValue(input: unknown) {
  let url: URL
  try {
    url = new URL(String(input))
  } catch {
    throw new WebError('invalid_url', '需要完整 HTTP(S) 地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new WebError('invalid_url', '仅支持不含凭据的 HTTP(S) 地址')
  return url.href
}
export function sourceId(url: string) {
  return 'src_' + createHash('sha256').update(url).digest('hex').slice(0, 16)
}
export const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
export const string: JsonObject = { type: 'string', minLength: 1 }
export const integer = (minimum: number, maximum: number): JsonObject => ({
  type: 'integer',
  minimum,
  maximum,
})
export const choice = (...values: string[]): JsonObject => ({ type: 'string', enum: values })
export const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {})
  })
}
