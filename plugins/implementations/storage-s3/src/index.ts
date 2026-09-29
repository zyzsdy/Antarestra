import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import '@antarestra/storage'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'
import { S3Backend } from './backend.js'
import type { Config } from './backend.js'
export { S3Backend } from './backend.js'
export type { Config } from './backend.js'
export const name = '@antarestra/plugin-storage-s3'
export const inject = ['storage']
export async function apply(ctx: Context, config: Config) {
  config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), config)
  const backend = new S3Backend(config)
  ctx.effect(() => () => backend.close())
  ctx.storage.register(ctx, config.id ?? 's3', backend)
  await ctx.plugin({
    inject: ['webui'],
    apply(ctx: Context) {
      const endpoint = new URL(config.publicEndpoint ?? config.endpoint)
      ctx.webui.addConnectOrigin(ctx, endpoint.origin)
      if (config.forcePathStyle === false) {
        endpoint.hostname = `${config.bucket}.${endpoint.hostname}`
        ctx.webui.addConnectOrigin(ctx, endpoint.origin)
      }
      ctx.webui.addEntry(ctx, {
        id: 'storage-s3',
        directory: fileURLToPath(new URL('../public/', import.meta.url)),
      })
    },
  })
}
