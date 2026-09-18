import { schemaConfig } from '@antarestra/plugin-sdk/schema'
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
  return schemaConfig<Required<Config>>(new URL('../config.schema.json', import.meta.url), input)
}
