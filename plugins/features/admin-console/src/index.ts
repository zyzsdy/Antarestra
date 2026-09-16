import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/rbac'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

export const name = '@antarestra/plugin-admin-console'
export const inject = ['webui', 'rbac', 'server']
export function apply(ctx: Context) {
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '访问管理控制台', ['admin'])
  ctx.rbac.publicRoute(ctx, 'GET', '/admin-console/session')
  ctx.server.route(ctx, 'GET', '/admin-console/session', async (http) => {
    http.set('Cache-Control', 'no-store')
    const auth = await ctx.rbac.authenticate(ctx.rbac.token(http))
    if (!auth) {
      http.status = 401
      http.body = { error: '请先登录', loginPath: ctx.rbac.loginPath('web') }
      return
    }
    if (!(await ctx.rbac.can(auth, 'admin.console.view'))) {
      http.status = 403
      http.body = { error: '没有访问管理控制台的权限' }
      return
    }
    const permission = http.query.permission
    if (
      permission !== undefined &&
      (typeof permission !== 'string' || !(await ctx.rbac.can(auth, permission)))
    ) {
      http.status = 403
      http.body = { error: '没有访问此页面的权限' }
      return
    }
    http.body = {
      actorId: auth.principalId,
      displayName: (await ctx.rbac.principal(auth.principalId))?.display_name ?? '管理员',
      accountPath: ctx.rbac.loginPath('web', auth.providerId),
    }
  })
  ctx.webui.addEntry(ctx, {
    id: 'admin-console',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
  })
}
