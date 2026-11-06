import { AuthError } from '@antarestra/rbac'
import type { ServerRecord, TransportKind } from './types.js'
function check(value: unknown, message: string): asserts value {
  if (!value) throw new AuthError(400, message)
}
function text(body: Record<string, unknown>, key: string, max: number, required = false) {
  const value = body[key]
  check(
    typeof value === 'string' && value.length <= max && (!required || value.trim()),
    `${key} 内容无效或超过长度限制`,
  )
  return value
}
function secrets(value: unknown, previous: Record<string, string>, headers: boolean) {
  check(
    value && typeof value === 'object' && !Array.isArray(value),
    '请求头或环境变量必须是键值对象',
  )
  const entries = Object.entries(value)
  check(entries.length <= 100, '请求头或环境变量最多 100 项')
  const result: Record<string, string> = Object.create(null)
  const names = new Set<string>()
  for (const [key, input] of entries) {
    check(
      headers
        ? /^[!#$%&'*+.^_`|~0-9a-z-]{1,200}$/i.test(key)
        : /^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(key),
      '请求头或环境变量名称无效',
    )
    const normalized = headers ? key.toLowerCase() : key
    check(!names.has(normalized), '请求头名称重复')
    names.add(normalized)
    const resolved = input === null ? previous[normalized] : input
    check(
      typeof resolved === 'string' && resolved.length <= 16384 && !resolved.includes('\0'),
      '请输入请求头或环境变量值',
    )
    check(!headers || !/[\r\n]/.test(resolved), '请求头不能包含换行')
    result[normalized] = resolved
  }
  return result
}
export function validate(
  body: Record<string, unknown>,
  previous?: ServerRecord,
): Omit<ServerRecord, 'id' | 'order'> {
  check(Number.isSafeInteger(body.revision) && Number(body.revision) > 0, '配置版本无效')
  check(['local', 'streamable-http', 'sse'].includes(String(body.transport)), '连接类型无效')
  check(
    typeof body.enabled === 'boolean' && typeof body.prefixEnabled === 'boolean',
    '开关配置无效',
  )
  const transport = body.transport as TransportKind
  const url = text(body, 'url', 4096).trim()
  if (transport !== 'local') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new AuthError(400, '请输入完整的 HTTP 或 HTTPS 地址')
    }
    check(
      ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash,
      '地址必须使用 HTTP/HTTPS，且不能包含用户名、密码或片段',
    )
  }
  const command = text(body, 'command', 4096, transport === 'local').trim()
  const cwd = text(body, 'cwd', 4096).trim()
  check(!command.includes('\0') && !cwd.includes('\0'), '命令或工作目录无效')
  check(
    Array.isArray(body.args) &&
      body.args.length <= 200 &&
      body.args.every((v) => typeof v === 'string' && v.length <= 16384 && !v.includes('\0')),
    '启动参数需为字符串数组，最多 200 项',
  )
  const prefix = text(body, 'prefix', 100).trim()
  check(
    !body.prefixEnabled || /^[A-Za-z0-9_-]+$/.test(prefix),
    '启用前缀后，请输入字母、数字、下划线或短横线',
  )
  return {
    revision: Number(body.revision),
    name: text(body, 'name', 200, true).trim(),
    description: text(body, 'description', 4000),
    activationDescription: text(body, 'activationDescription', 8000),
    transport,
    enabled: body.enabled,
    prefixEnabled: body.prefixEnabled,
    prefix,
    url,
    command,
    cwd,
    args: [...body.args] as string[],
    headers: secrets(body.headers, previous?.headers ?? {}, true),
    env: secrets(body.env, previous?.env ?? {}, false),
  }
}
