import { fileURLToPath } from 'node:url'
import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/webui'
import { catalog } from './catalog.js'
import { migrations, name } from './store.js'
import { apiFormats } from './types.js'
import { check, identifier, text } from './validation.js'
import { AiProviderService } from './service.js'
import { CodexSubscriptions } from './codex.js'
export { AiProviderService } from './service.js'
export type { ProviderView, Candidate, Discovery } from './types.js'

export default defineDatabasePlugin({
  name,
  migrations,
  inject: ['ai', 'rbac'],
  async apply(ctx, config: { codexCredentialsDirectory?: string } = {}) {
    ctx.rbac.registerPermission(ctx, 'admin.ai.providers.manage', '管理 AI 提供商与模型', ['admin'])
    ctx.rbac.registerPermission(ctx, 'admin.ai.codex.manage', '管理本人的 ChatGPT 订阅', ['admin'])
    await ctx.plugin(AiProviderService)
    await ctx.plugin({
      inject: ['aiProvider', 'ai', 'rbac'],
      async apply(ctx: Context) {
        await ctx.aiProvider.initialize()
        const codex = new CodexSubscriptions(
          ctx,
          config.codexCredentialsDirectory ?? 'data/codex-subscription',
        )
        await codex.initialize()
        ctx.inject(['webui'], (ctx) => {
          ctx.webui.addEntry(ctx, {
            id: 'ai-provider',
            directory: fileURLToPath(new URL('../public/', import.meta.url)),
          })
        })
        ctx.inject(['server'], (ctx) => {
          const owner = (http: HttpContext) => ctx.rbac.auth(http).principalId
          const codexRoute = (
            method: string,
            path: string,
            action: (http: HttpContext) => unknown,
          ) => {
            ctx.server.route(
              ctx,
              method,
              '/codex-subscription' + path,
              ctx.rbac.require('admin.console.view'),
              ctx.rbac.require('admin.ai.codex.manage'),
              async (http) => {
                http.set('Cache-Control', 'no-store')
                try {
                  http.body = await action(http)
                } catch (error) {
                  if (error instanceof AuthError) throw error
                  throw new AuthError(502, '订阅操作失败，请检查网络或重新授权')
                }
              },
            )
          }
          codexRoute('GET', '', (http) => codex.list(owner(http)))
          codexRoute('POST', '/login', async (http) => {
            const body = await readJson(http)
            check(
              body.accountId === undefined || typeof body.accountId === 'string',
              '账户 ID 无效',
            )
            return codex.begin(owner(http), body.accountId as string | undefined)
          })
          codexRoute('GET', '/login/:id', (http) =>
            codex.status(owner(http), identifier(http.params.id)),
          )
          codexRoute('POST', '/login/:id/complete', async (http) =>
            codex.complete(
              owner(http),
              identifier(http.params.id),
              text((await readJson(http, 32768)).callback, '回调地址', 16384),
            ),
          )
          codexRoute('DELETE', '/login/:id', async (http) => {
            await readJson(http)
            return codex.cancel(owner(http), identifier(http.params.id))
          })
          codexRoute('POST', '/accounts/:id/sync', async (http) => {
            await readJson(http)
            return codex.sync(owner(http), identifier(http.params.id))
          })
          codexRoute('POST', '/accounts/:id/disconnect', async (http) => {
            await readJson(http)
            return codex.disconnect(owner(http), identifier(http.params.id))
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
        })
      },
    })
  },
})
