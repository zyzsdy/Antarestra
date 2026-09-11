import type Koa from 'koa'
import { inspect } from 'node:util'
import { Readable } from 'node:stream'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
  })
}

export function renderError(error: unknown): string {
  const details: string[] = []
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) {
      details.push('原因链包含循环，已省略。')
      break
    }
    seen.add(current)
    if (current instanceof Error) {
      details.push(current.stack ?? `${current.name}: ${current.message}`)
      if (current.cause === undefined) break
      current = current.cause
      if (depth === 7) details.push('原因链过长，已省略后续内容。')
    } else {
      details.push(inspect(current, { depth: 3, customInspect: false, getters: false }))
      break
    }
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>500 · 服务器内部错误</title>
<style>
body { margin: 0; background: #f5f6f8; color: #242a35; font: 16px/1.6 system-ui, sans-serif; }
main { max-width: 960px; margin: 48px auto; padding: 0 24px; }
h1 { font-size: 28px; line-height: 1.3; }
p { color: #596273; }
pre { padding: 20px; border: 1px solid #dce0e6; border-radius: 8px; background: white;
  font: 13px/1.7 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) { main { margin: 24px auto; padding: 0 16px; } h1 { font-size: 24px; } pre { padding: 14px; } }
</style>
</head>
<body><main><h1>500 · 服务器内部错误</h1>
<p>请求处理失败。以下详细信息仅在 debug 模式下显示。</p>
${details.map((detail) => `<pre>${escapeHtml(detail)}</pre>`).join('\n')}
</main></body></html>`
}

// 同时用于中间件异常和 Koa 的响应写入、流错误回调。
export function respondError(ctx: Koa.Context, error: unknown, debug: boolean): void {
  const { res } = ctx
  const previous: unknown = ctx.body
  if (previous instanceof Readable) {
    previous.unpipe(res)
    previous.once('error', () => {})
    previous.destroy()
  }
  if (res.headersSent || res.destroyed || res.writableEnded) {
    res.destroy()
    return
  }
  for (const header of res.getHeaderNames()) res.removeHeader(header)
  let body = '{"error":"Internal Server Error"}'
  if (debug) {
    try {
      body = renderError(error)
    } catch {
      body = renderError(new Error('无法读取异常详情'))
    }
  }
  ctx.respond = false
  res.statusCode = 500
  res.statusMessage = 'Internal Server Error'
  res.setHeader(
    'Content-Type',
    debug ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
  )
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(ctx.method === 'HEAD' ? undefined : body)
}
