import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/rbac'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

export const name = '@antarestra/plugin-admin-console'
export const inject = ['webui', 'rbac']
export function apply(ctx: Context) {
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '访问管理控制台', ['admin'])
  ctx.webui.addEntry(ctx, {
    id: 'admin-console',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
    config: { loginPath: ctx.rbac.loginPath('web') ?? '/auth/user/' },
  })
}
