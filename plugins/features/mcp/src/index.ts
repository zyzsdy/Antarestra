import { fileURLToPath } from 'node:url'
import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { AiError } from '@antarestra/ai'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/webui'
import { migrations, name } from './store.js'
import { McpService } from './service.js'
export { McpService } from './service.js'
export type { ServerRecord, ServerView, ServerInput } from './types.js'

export default defineDatabasePlugin({
  name,
  migrations,
  inject: ['ai', 'rbac'],
  async apply(ctx) {
    ctx.rbac.registerPermission(ctx, 'admin.ai.mcp.manage', '管理 MCP 服务器', ['admin'])
    await ctx.plugin(McpService)
    await ctx.plugin({
      inject: ['mcp', 'ai', 'rbac'],
      async apply(ctx: Context) {
        await ctx.mcp.initialize()
        ctx.inject(['webui'], (ctx) => {
          ctx.webui.addEntry(ctx, {
            id: 'mcp',
            directory: fileURLToPath(new URL('../public/', import.meta.url)),
          })
        })
        ctx.inject(['server'], (ctx) => {
          const route = (
            method: string,
            path: string,
            action: (http: HttpContext) => Promise<unknown>,
          ) => {
            ctx.server.route(
              ctx,
              method,
              '/mcp' + path,
              ctx.rbac.require('admin.console.view'),
              ctx.rbac.require('admin.ai.mcp.manage'),
              async (http) => {
                http.set('Cache-Control', 'no-store')
                try {
                  http.body = await action(http)
                } catch (error) {
                  if (error instanceof AuthError) throw error
                  if (error instanceof AiError) throw new AuthError(error.status, error.message)
                  throw new AuthError(500, 'MCP 操作失败，请检查服务状态后重试')
                }
              },
            )
          }
          const id = (http: HttpContext) => {
            const value = http.params.id
            if (typeof value !== 'string' || !value) throw new AuthError(400, 'MCP ID 无效')
            return value
          }
          route('GET', '', async () => ctx.mcp.list())
          route('POST', '', async (http) => ctx.mcp.save(await readJson(http, 524288)))
          route('PUT', '/:id', async (http) => ctx.mcp.save(await readJson(http, 524288), id(http)))
          route('POST', '/:id/reconnect', async (http) =>
            ctx.mcp.reconnect(id(http), (await readJson(http)).revision),
          )
          route('DELETE', '/:id', async (http) =>
            ctx.mcp.remove(id(http), (await readJson(http)).revision),
          )
        })
      },
    })
  },
})
