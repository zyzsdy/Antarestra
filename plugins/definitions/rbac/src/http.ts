import type { HttpContext, Middleware } from '@antarestra/plugin-server'

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const errors: Middleware = async (http, next) => {
  http.set('Cache-Control', 'no-store')
  try {
    await next()
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    http.status = error.status
    http.body = { error: error.message }
  }
}

/** JSON 限制与同源检查同时防止 Cookie 会话被跨站表单利用。 */
export async function readJson(http: HttpContext): Promise<Record<string, unknown>> {
  if (http.get('origin') && http.get('origin') !== `${http.protocol}://${http.host}`)
    throw new AuthError(403, '请求来源不匹配')
  if (http.get('sec-fetch-site') === 'cross-site') throw new AuthError(403, '不允许跨站请求')
  if (!http.is('application/json')) throw new AuthError(415, '请求必须使用 JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of http.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > 16_384) throw new AuthError(413, '请求内容过大')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AuthError(400, 'JSON 格式无效')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AuthError(400, '请求必须是对象')
  return value as Record<string, unknown>
}

export function textField(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new AuthError(400, `${label}无效`)
  return value.trim()
}
