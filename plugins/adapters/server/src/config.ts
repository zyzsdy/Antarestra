export interface Config {
  host?: string
  port?: number
  publicUrl?: string
  https?: boolean
  cert?: string
  key?: string
  passphraseFile?: string
  debug?: boolean
}

export function resolveConfig(config: Config): Readonly<Required<Config>> {
  const result = {
    host: '0.0.0.0',
    port: 14451,
    publicUrl: '',
    https: false,
    cert: '',
    key: '',
    passphraseFile: '',
    debug: false,
    ...config,
  }
  for (const field of ['host', 'publicUrl', 'cert', 'key', 'passphraseFile'] as const) {
    if (typeof result[field] !== 'string') throw new Error(`server 配置 ${field} 必须是字符串`)
  }
  for (const field of ['https', 'debug'] as const) {
    if (typeof result[field] !== 'boolean') throw new Error(`server 配置 ${field} 必须是布尔值`)
  }
  if (!result.host.trim()) throw new Error('server 监听地址不能为空')
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) {
    throw new Error('server 端口必须是 0–65535 的整数')
  }
  if (result.publicUrl) {
    let url: URL
    try {
      url = new URL(result.publicUrl)
    } catch {
      throw new Error('server 外网地址必须是有效的 HTTP/HTTPS URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error('server 外网地址必须是无凭据的 HTTP/HTTPS URL')
    }
  }
  if (result.https && (!result.cert.trim() || !result.key.trim())) {
    throw new Error('server 启用 HTTPS 时必须配置证书和私钥文件')
  }
  return Object.freeze(result)
}
