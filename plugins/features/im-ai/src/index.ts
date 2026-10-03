import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineDatabasePlugin } from '@antarestra/database'
import { ImAiService } from './service.js'
import type { Config } from './service.js'
import { migrations, pluginId } from './store.js'

export { ImAiService } from './service.js'
export type { Config } from './service.js'
export { activated, finalText } from './messages.js'
export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['im', 'imCommands', 'ai'],
  async apply(ctx: Context, input: Partial<Config> = {}) {
    const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
    await ctx.plugin(ImAiService, config)
  },
})
