import type { Context } from '@antarestra/plugin-sdk'
import { resolveConfig, levels } from './config.js'
import type { Config } from './config.js'
import { colorDepth, createColorizer } from './colors.js'
import { cleanName, formatMessage } from './format.js'
import { FileWriter } from './file.js'

export type { Config } from './config.js'
export const name = 'logger'

function threshold(level: number): Record<string, number> {
  const result = { default: level }
  Object.setPrototypeOf(result, null)
  return result
}

export async function apply(ctx: Context, input: Config = {}): Promise<void> {
  const config = resolveConfig(input)
  await ctx.effect(async () => {
    const writer = config.file ? new FileWriter(config) : undefined
    await writer?.init()
    const disposers: (() => Promise<void>)[] = []
    try {
      if (config.console) {
        const colorize = createColorizer(colorDepth(process.stdout))
        disposers.push(
          ctx.logger.exporter({
            levels: threshold(levels[config.consoleLevel]),
            export(message) {
              process.stdout.write(formatMessage(message, colorize(cleanName(message.name))))
            },
          }),
        )
      }
      if (writer) {
        disposers.push(
          ctx.logger.exporter({
            levels: threshold(levels[config.fileLevel]),
            export(message) {
              writer.write(formatMessage(message, `[${cleanName(message.name)}]`), message.ts)
            },
          }),
        )
      }
    } catch (error) {
      for (const dispose of disposers) await dispose()
      await writer?.close()
      throw error
    }
    return async () => {
      for (const dispose of disposers) await dispose()
      await writer?.close()
    }
  })
}
