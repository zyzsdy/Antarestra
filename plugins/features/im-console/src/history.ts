import type { Context } from '@antarestra/plugin-sdk'
import { AuthError, readJson } from '@antarestra/rbac'
import '@antarestra/plugin-im-commands'
import type { ImCommandsService } from '@antarestra/plugin-im-commands'
import type { HistoryQuery } from '@antarestra/im'
import { ImError } from '@antarestra/im'

function integer(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AuthError(400, '分页参数无效')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > max)
    throw new AuthError(400, '分页参数无效')
  return number
}
export function historyRoutes(ctx: Context) {
  let admins: ImCommandsService['admins'] | undefined
  ctx.inject(['imCommands'], (owner) => {
    const service = owner.imCommands.admins
    owner.effect(() => {
      admins = service
      return () => {
        if (admins === service) admins = undefined
      }
    })
  })
  async function requireGroup(workspaceId: string) {
    try {
      await ctx.im.requireGroup(workspaceId)
    } catch (error) {
      if (error instanceof ImError) throw new AuthError(error.status, error.message)
      throw error
    }
  }
  ctx.rbac.registerPermission(ctx, 'admin.im.history.view', '查看全部 IM 群消息与 AI 会话', [
    'admin',
  ])
  const guards = [ctx.rbac.require('admin.console.view'), ctx.rbac.require('admin.im.history.view')]
  ctx.rbac.registerPermission(ctx, 'admin.im.bot.manage', '管理各群 bot 管理员', ['admin'])
  const adminGuards = [...guards, ctx.rbac.require('admin.im.bot.manage')]
  ctx.server.route(ctx, 'GET', '/im/groups/:workspaceId/admins', ...adminGuards, async (http) => {
    const id = String(http.params.workspaceId)
    await requireGroup(id)
    if (!admins) throw new AuthError(503, 'IM 命令插件未启用')
    http.set('Cache-Control', 'no-store')
    http.body = await admins.get(id)
  })
  ctx.server.route(ctx, 'PUT', '/im/groups/:workspaceId/admins', ...adminGuards, async (http) => {
    const id = String(http.params.workspaceId)
    await requireGroup(id)
    if (!admins) throw new AuthError(503, 'IM 命令插件未启用')
    const input = await readJson(http, 65536)
    http.set('Cache-Control', 'no-store')
    http.body = await admins.set(id, input.users, input.revision)
  })
  ctx.server.route(ctx, 'GET', '/im/groups', ...guards, async (http) => {
    http.set('Cache-Control', 'no-store')
    http.body = await ctx.im.listGroups(integer(http.query.offset, 0), 20)
  })
  ctx.server.route(ctx, 'GET', '/im/groups/:workspaceId/messages', ...guards, async (http) => {
    const workspaceId = String(http.params.workspaceId)
    await requireGroup(workspaceId)
    const query: HistoryQuery = { limit: 51 }
    if (http.query.before !== undefined) query.beforeSequence = integer(http.query.before, 0)
    if (http.query.keyword !== undefined) {
      if (typeof http.query.keyword !== 'string' || http.query.keyword.length > 200)
        throw new AuthError(400, '关键词最多 200 字')
      query.keyword = http.query.keyword
    }
    const messages = await ctx.im.history(workspaceId, query)
    const hasMore = messages.length > 50
    const page = hasMore ? messages.slice(1) : messages
    http.set('Cache-Control', 'no-store')
    http.body = {
      messages: page.map(({ message: { raw: _raw, ...message }, ...entry }) => ({
        ...entry,
        message,
      })),
      nextBefore: hasMore ? page[0]!.sequence - 1 : null,
    }
  })
  ctx.server.route(ctx, 'GET', '/im/groups/:workspaceId/ai', ...guards, async (http) => {
    const workspaceId = String(http.params.workspaceId)
    await requireGroup(workspaceId)
    const offset = integer(http.query.offset, 0)
    const reader = ctx.im.aiHistory
    http.set('Cache-Control', 'no-store')
    http.body = reader
      ? { available: true, ...(await reader.list(workspaceId, offset, 20)) }
      : { available: false, entries: [], total: 0, currentConversationId: null }
  })
  ctx.server.route(ctx, 'GET', '/im/groups/:workspaceId/ai/:id', ...guards, async (http) => {
    const workspaceId = String(http.params.workspaceId)
    await requireGroup(workspaceId)
    const reader = ctx.im.aiHistory
    if (!reader) throw new AuthError(503, 'IM AI 历史服务未启用，请启用 IM AI 插件后重试')
    const detail = await reader.detail(workspaceId, String(http.params.id))
    if (!detail) throw new AuthError(404, '该群的 AI 处理记录不存在')
    http.set('Cache-Control', 'no-store')
    http.body = detail
  })
}
