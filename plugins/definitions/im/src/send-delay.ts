import type { MessageSegment } from './types.js'

export interface SendDelayConfig {
  sendDelayPerCharMs: number
  longMessageThreshold: number
  longMessageDelayPerCharMs: number
}

export function messageSendDelay(segments: readonly MessageSegment[], config: SendDelayConfig) {
  if (!config.sendDelayPerCharMs) return 0
  const length = segments.reduce(
    (total, segment) => total + (segment.type === 'text' ? Array.from(segment.text).length : 0),
    0,
  )
  return (
    length *
    (length > config.longMessageThreshold
      ? config.longMessageDelayPerCharMs
      : config.sendDelayPerCharMs)
  )
}

export async function waitForSend(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  while (milliseconds > 0) {
    // Node 的单次定时器上限为有符号 32 位整数，分段等待避免溢出后立即发送。
    const duration = Math.min(milliseconds, 2 ** 31 - 1)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, duration)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    signal.throwIfAborted()
    milliseconds -= duration
  }
}
