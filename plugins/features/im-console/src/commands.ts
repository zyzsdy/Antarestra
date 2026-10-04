import type { Context } from '@antarestra/plugin-sdk'
import { AuthError, readJson } from '@antarestra/rbac'
import type { ImCommandsService } from '@antarestra/plugin-im-commands'
import '@antarestra/plugin-im-commands'

export function commandRoutes(ctx: Context) {
  let commands: ImCommandsService | undefined
  ctx.inject(['imCommands'], (owner) => {
    const service = owner.imCommands
    owner.effect(() => {
      commands = service
      return () => {
        if (commands === service) commands = undefined
      }
    })
  })
  const service = () => {
    if (!commands) throw new AuthError(503, 'IM 命令插件未启用，请启用后重试')
    return commands
  }
  ctx.rbac.registerPermission(ctx, 'admin.im.commands.manage', '管理 IM 命令权限', ['admin'])
  const guards = [
    ctx.rbac.require('admin.console.view'),
    ctx.rbac.require('admin.im.commands.manage'),
  ]
  ctx.server.route(ctx, 'GET', '/im/commands', ...guards, async (http) => {
    const offset = http.query.offset ?? '0'
    const search = http.query.search ?? ''
    if (
      typeof offset !== 'string' ||
      !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(Number(offset))
    )
      throw new AuthError(400, '分页参数无效')
    if (typeof search !== 'string' || search.length > 200)
      throw new AuthError(400, '搜索词最多 200 字符')
    http.set('Cache-Control', 'no-store')
    http.body = await service().listCommands(Number(offset), search.trim())
  })
  ctx.server.route(ctx, 'GET', '/im/commands/:name', ...guards, async (http) => {
    http.set('Cache-Control', 'no-store')
    http.body = await service().getPolicy(String(http.params.name))
  })
  ctx.server.route(ctx, 'PUT', '/im/commands/:name', ...guards, async (http) => {
    const input = await readJson(http, 524288)
    http.set('Cache-Control', 'no-store')
    http.body = await service().setPolicy(String(http.params.name), input.policy, input.revision)
  })
}
