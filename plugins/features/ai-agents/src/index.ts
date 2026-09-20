import { fileURLToPath } from 'node:url'
import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { AiError } from '@antarestra/ai'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/webui'
import { migrations, name } from './store.js'
import { AiAgentsService } from './service.js'
import { defaultAgentId } from './types.js'
export { AiAgentsService } from './service.js'
export * from './types.js'

export default defineDatabasePlugin({
  name,
  migrations,
  inject: ['ai', 'rbac', 'server', 'webui'],
  async apply(ctx) {
    ctx.rbac.registerPermission(ctx, 'admin.ai.agents.manage', '管理 Agents', ['admin'])
    await ctx.plugin(AiAgentsService)
    await ctx.plugin({
      inject: ['aiAgents', 'ai', 'rbac', 'server', 'webui'],
      async apply(ctx: Context) {
        await ctx.aiAgents.initialize()
        ctx.webui.addEntry(ctx, {
          id: 'ai-agents',
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
            '/ai-agents' + path,
            ctx.rbac.require('admin.console.view'),
            ctx.rbac.require('admin.ai.agents.manage'),
            async (http) => {
              http.set('Cache-Control', 'no-store')
              try {
                http.body = await action(http)
              } catch (error) {
                if (error instanceof AuthError) throw error
                if (error instanceof AiError) throw new AuthError(error.status, error.message)
                throw new AuthError(500, 'Agent 操作失败，请检查服务状态后重试')
              }
            },
          )
        }
        const id = (http: HttpContext) => {
          const value = http.params.id
          if (typeof value !== 'string' || !value) throw new AuthError(400, 'Agent ID 无效')
          return value
        }
        route('GET', '', async () => ({ agents: ctx.aiAgents.list(), defaultAgentId }))
        route('GET', '/capabilities', async () => ctx.ai.capabilities())
        route('POST', '', async (http) => ctx.aiAgents.save(await readJson(http, 524288)))
        route('PUT', '/:id', async (http) =>
          ctx.aiAgents.save(await readJson(http, 524288), id(http)),
        )
        route('DELETE', '/:id', async (http) =>
          ctx.aiAgents.remove(id(http), (await readJson(http)).revision),
        )
      },
    })
  },
})
