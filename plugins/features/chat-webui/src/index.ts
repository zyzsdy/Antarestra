import type { Context } from '@antarestra/plugin-sdk'
import { AuthError } from '@antarestra/rbac'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

export const name = '@antarestra/plugin-chat-webui'
export const inject = ['webui', 'rbac', 'server']
export function apply(ctx: Context) {
  ctx.rbac.registerPermission(ctx, 'chat.webui.view', '使用Web聊天界面', ['user', 'admin'])
  ctx.rbac.publicRoute(ctx, 'GET', '/chat-webui/session')
  ctx.server.route(ctx, 'GET', '/chat-webui/session', async (http) => {
    http.set('Cache-Control', 'no-store')
    try {
      const access = await ctx.rbac.authorizeRequest('web', http, 'chat.webui.view')
      if (!access.actorId || !access.workspaceId) throw new AuthError(401, '请先登录')
      // 当前只支持认证提供者解析出的个人空间；绝不接受客户端指定其他空间。
      if (http.query.workspaceId !== undefined && http.query.workspaceId !== access.workspaceId)
        throw new AuthError(403, '不能访问其他工作空间')
      const principal = await ctx.rbac.principal(access.actorId)
      http.body = {
        actorId: access.actorId,
        workspaceId: access.workspaceId,
        roles: access.roles,
        requestSource: access.requestSource,
        displayName: principal?.display_name ?? '用户',
        accountPath: ctx.rbac.loginPath('web', access.auth?.providerId),
      }
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        http.status = 401
        http.body = { error: '请先登录', loginPath: ctx.rbac.loginPath('web') }
        return
      }
      throw error
    }
  })
  ctx.webui.addEntry(ctx, {
    id: 'chat-webui',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
  })
}
