import { setTimeout as delay } from 'node:timers/promises'
import type { ModelDriver } from './types.js'
import { abortable, AiError } from './utils.js'

function transient(error: unknown) {
  if (!(error instanceof AiError) || error.code !== 'provider_request_failed') return false
  // 部分驱动（包括 pi 流错误）仅保留错误文本，优先采用明确的 HTTP 状态。
  const status = /(?:API error\s*\(|\bHTTP\s+|^)(\d{3})\b/i.exec(error.message)?.[1]
  const code = status ? Number(status) : error.status
  if (status || code !== 400) return code === 408 || code === 429 || (code >= 500 && code <= 599)
  return /\b(?:server_error|overloaded_error|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|service temporarily unavailable|fetch failed|connection error|stream was interrupted/i.test(
    error.message,
  )
}

/** 仅重试当前模型请求；已流出内容或执行内置工具时不重放，防止重复输出与副作用。 */
export async function generateWithRetry(
  driver: ModelDriver,
  args: Parameters<ModelDriver['generate']>,
  maxRetries: number,
  onRetry: (attempt: number, error: AiError) => Promise<void>,
) {
  const [request, connection, context, update] = args
  let emitted = false
  for (let attempt = 0; ; attempt++) {
    context.signal.throwIfAborted()
    try {
      return await abortable(
        driver.generate(request, connection, context, async (event) => {
          context.signal.throwIfAborted()
          if (event.type === 'provider-tool' || (event.type === 'delta' && event.text.length > 0))
            emitted = true
          await update(event)
        }),
        context.signal,
      )
    } catch (error) {
      context.signal.throwIfAborted()
      if (emitted || attempt >= maxRetries || !transient(error)) throw error
      await onRetry(attempt + 1, error as AiError)
      await delay(Math.min(1000 * 2 ** attempt, 30000), undefined, { signal: context.signal })
      await update({ type: 'activity' })
    }
  }
}
