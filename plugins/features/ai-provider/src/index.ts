import { fileURLToPath } from 'node:url'
import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/webui'
import { catalog } from './catalog.js'
import { migrations, name } from './store.js'
import { apiFormats } from './types.js'
import { identifier } from './validation.js'
import { AiProviderService } from './service.js'
export { AiProviderService } from './service.js'
export type { ProviderView, Candidate, Discovery } from './types.js'

export default defineDatabasePlugin({
  name,
  migrations,
  inject: ['ai', 'rbac', 'server', 'webui'],
  async apply(ctx) {
    ctx.rbac.registerPermission(ctx, 'admin.ai.providers.manage', '管理 AI 提供商与模型', ['admin'])
    await ctx.plugin(AiProviderService)
    await ctx.plugin({
      inject: ['aiProvider', 'ai', 'rbac', 'server', 'webui'],
      async apply(ctx: Context) {
        await ctx.aiProvider.initialize()
        ctx.webui.addEntry(ctx, {
          id: 'ai-provider',
          directory: fileURLToPath(new URL('../public/', import.meta.url)),
        })
        const route = (
          method: string,
          path: string,
          action: (http: HttpContext) => Promise<unknown>,
        ) => {
          ctx.server.route(
            ctx,
            method,
            '/ai-providers' + path,
            ctx.rbac.require('admin.console.view'),
            ctx.rbac.require('admin.ai.providers.manage'),
            async (http) => {
              http.set('Cache-Control', 'no-store')
              try {
                http.body = await action(http)
              } catch (error) {
                if (error instanceof AuthError) throw error
                throw new AuthError(500, '提供商操作失败，请检查服务状态后重试')
              }
            },
          )
        }
        const id = (http: HttpContext) => identifier(http.params.id)
        route('GET', '', async () => ctx.aiProvider.list())
        route('GET', '/catalog', async () => ({ providers: catalog(), formats: apiFormats }))
        route('POST', '', async (http) => ctx.aiProvider.save(await readJson(http, 131072)))
        route('GET', '/:id', async (http) => ctx.aiProvider.detail(id(http)))
        route('PUT', '/:id', async (http) =>
          ctx.aiProvider.save(await readJson(http, 131072), id(http)),
        )
        route('DELETE', '/:id', async (http) =>
          ctx.aiProvider.remove(id(http), (await readJson(http)).revision),
        )
        route('PUT', '/:id/models', async (http) =>
          ctx.aiProvider.models(id(http), await readJson(http, 4_194_304)),
        )
        route('PUT', '/:id/builtin-tools', async (http) =>
          ctx.aiProvider.builtinTools(id(http), await readJson(http, 131072)),
        )
        route('GET', '/:id/candidates', async (http) => ctx.aiProvider.discover(id(http), false))
        route('POST', '/:id/discover', async (http) => {
          await readJson(http)
          return ctx.aiProvider.discover(id(http), true)
        })
      },
    })
  },
})
