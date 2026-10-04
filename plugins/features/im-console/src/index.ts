import type { Context } from '@antarestra/plugin-sdk'
import { AuthError, readJson } from '@antarestra/rbac'
import type { ConnectionPolicy } from '@antarestra/im'
import '@antarestra/im'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'
import { historyRoutes } from './history.js'
import { commandRoutes } from './commands.js'

export const name = 'im-console'
export const inject = ['webui', 'im', 'rbac', 'server']
export function apply(ctx: Context) {
  historyRoutes(ctx)
  commandRoutes(ctx)
  ctx.rbac.registerPermission(ctx, 'admin.im.manage', '管理 IM 接入与聊天规则', ['admin'])
  ctx.webui.addEntry(ctx, {
    id: 'im-console',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
  })
  const guards = [ctx.rbac.require('admin.console.view'), ctx.rbac.require('admin.im.manage')]
  ctx.server.route(ctx, 'GET', '/im/connections', ...guards, (http) => {
    http.set('Cache-Control', 'no-store')
    http.body = { connections: ctx.im.listConnections() }
  })
  ctx.server.route(ctx, 'GET', '/im/connections/:id/policy', ...guards, (http) => {
    const id = String(http.params.id)
    if (!ctx.im.listConnections().some((item) => item.id === id))
      throw new AuthError(404, 'IM 接入不存在或尚未启用')
    http.set('Cache-Control', 'no-store')
    http.body = { policy: ctx.im.getPolicy(id), revision: ctx.im.getPolicyRevision(id) }
  })
  ctx.server.route(ctx, 'PUT', '/im/connections/:id/policy', ...guards, async (http) => {
    const id = String(http.params.id)
    if (!ctx.im.listConnections().some((item) => item.id === id))
      throw new AuthError(404, 'IM 接入不存在或尚未启用')
    const input = await readJson(http, 65536)
    if (
      !input.policy ||
      typeof input.policy !== 'object' ||
      Array.isArray(input.policy) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0
    )
      throw new AuthError(400, '请提供有效的聊天规则和修订号')
    try {
      await ctx.im.setPolicy(id, input.policy as ConnectionPolicy, Number(input.revision))
    } catch (error) {
      const status =
        error && typeof error === 'object' && 'status' in error && error.status === 409 ? 409 : 400
      throw new AuthError(status, error instanceof Error ? error.message : '聊天规则保存失败')
    }
    http.set('Cache-Control', 'no-store')
    http.body = { policy: ctx.im.getPolicy(id), revision: ctx.im.getPolicyRevision(id) }
  })
}
