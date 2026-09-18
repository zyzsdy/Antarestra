import { schemaConfig } from '@antarestra/plugin-sdk/schema'
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
  const result = schemaConfig<Required<Config>>(
    new URL('../config.schema.json', import.meta.url),
    config,
  )
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
