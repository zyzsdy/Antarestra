export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface Config {
  console?: boolean
  consoleLevel?: Level
  file?: boolean
  fileLevel?: Level
  directory?: string
  rotation?: 'none' | 'daily' | 'size'
  retentionDays?: number
  maxSize?: number
}

export const levels = { error: 0, warn: 1, info: 2, debug: 3 } as const

export function resolveConfig(input: Config = {}): Required<Config> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('logger 配置必须是对象')
  const config = {
    console: true,
    consoleLevel: 'info',
    file: false,
    fileLevel: 'debug',
    directory: '../../log',
    rotation: 'daily',
    retentionDays: 30,
    maxSize: 104857600,
    ...input,
  } satisfies Required<Config>
  for (const key of ['console', 'file'] as const) {
    if (typeof config[key] !== 'boolean') throw new TypeError(`logger.${key} 必须是布尔值`)
  }
  for (const key of ['consoleLevel', 'fileLevel'] as const) {
    if (typeof config[key] !== 'string' || !Object.hasOwn(levels, config[key]))
      throw new TypeError(`logger.${key} 日志等级无效`)
  }
  if (typeof config.directory !== 'string' || !config.directory.trim())
    throw new TypeError('logger.directory 不能为空')
  if (!['none', 'daily', 'size'].includes(config.rotation))
    throw new TypeError('logger.rotation 轮转类型无效')
  for (const key of ['retentionDays', 'maxSize'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0)
      throw new TypeError(`logger.${key} 必须是正安全整数`)
  }
  return config
}
