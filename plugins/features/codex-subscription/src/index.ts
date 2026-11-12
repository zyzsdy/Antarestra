import { fileURLToPath } from 'node:url'
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/ai'
import '@antarestra/webui'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import { CodexSubscriptions } from './codex.js'
import { check, identifier, text } from './validation.js'

export const name = '@antarestra/plugin-codex-subscription'
export const inject = ['ai', 'rbac']
export interface Config {
  credentialsDirectory?: string
  proxy?: string
}
export async function apply(ctx: Context, config: Config = {}) {
  ctx.rbac.registerPermission(ctx, 'admin.ai.codex.manage', '管理本人的 ChatGPT 订阅', ['admin'])
  const codex = new CodexSubscriptions(
    ctx,
    config.credentialsDirectory ?? 'data/codex-subscription',
    config.proxy,
  )
  await codex.initialize()
  ctx.inject(['webui'], (ctx) => {
    ctx.webui.addEntry(ctx, {
      id: 'codex-subscription',
      directory: fileURLToPath(new URL('../public/', import.meta.url)),
    })
  })
  ctx.inject(['server'], (ctx) => {
    const owner = (http: HttpContext) => ctx.rbac.auth(http).principalId
    const codexRoute = (method: string, path: string, action: (http: HttpContext) => unknown) => {
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
      check(body.accountId === undefined || typeof body.accountId === 'string', '账户 ID 无效')
      return codex.begin(owner(http), body.accountId as string | undefined)
    })
    codexRoute('GET', '/login/:id', (http) => codex.status(owner(http), identifier(http.params.id)))
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
  })
}
