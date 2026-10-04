import type { Context } from '@antarestra/plugin-sdk'
import { defineMigration } from '@antarestra/database'
import { AuthError } from '@antarestra/rbac'
import type { MessageContext } from '@antarestra/im'

export const pluginId = '@antarestra/plugin-im-commands'
interface Tables {
  admins: { workspace_id: string; revision: number; users: string }
}
export const migrations = [
  defineMigration({
    id: '001_group_admins',
    steps: [
      {
        kind: 'createTable',
        table: 'admins',
        columns: [
          { name: 'workspace_id', type: 'string', length: 200, primaryKey: true },
          { name: 'revision', type: 'integer', notNull: true },
          { name: 'users', type: 'text', notNull: true },
        ],
      },
    ],
  }),
]
export class GroupAdmins {
  constructor(
    private readonly ctx: Context,
    private readonly authorizeAdd: (message: MessageContext) => Promise<boolean>,
  ) {}
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  async get(workspaceId: string) {
    await this.ctx.im.requireGroup(workspaceId)
    const row = await this.db()
      .selectFrom('admins')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst()
    return { users: row ? (JSON.parse(row.users) as string[]) : [], revision: row?.revision ?? 0 }
  }
  async set(workspaceId: string, input: unknown, expected: unknown) {
    await this.ctx.im.requireGroup(workspaceId)
    if (
      !Array.isArray(input) ||
      input.length > 200 ||
      input.some(
        (id) =>
          typeof id !== 'string' || !id.trim() || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id),
      )
    )
      throw new AuthError(400, '管理员 ID 必须为不含空白的文本，最多 200 人')
    if (!Number.isSafeInteger(expected) || Number(expected) < 0)
      throw new AuthError(400, '修订号无效')
    const users = [...new Set(input as string[])]
    const row = {
      workspace_id: workspaceId,
      users: JSON.stringify(users),
      revision: Number(expected) + 1,
    }
    if (expected === 0) {
      try {
        await this.db().insertInto('admins').values(row).execute()
      } catch (error) {
        if ((await this.get(workspaceId)).revision > 0)
          throw new AuthError(409, '管理员名单已变化，请刷新后重试')
        throw error
      }
    } else {
      const result = await this.db()
        .updateTable('admins')
        .set(row)
        .where('workspace_id', '=', workspaceId)
        .where('revision', '=', Number(expected))
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1)
        throw new AuthError(409, '管理员名单已变化，请刷新后重试')
    }
    return { users, revision: row.revision }
  }
  async allowed(message: MessageContext) {
    if (message.message.chat.type !== 'group') return false
    if ((await this.ctx.im.authenticate(message.request))?.workspaceId !== message.workspaceId)
      return false
    const state = await this.get(message.workspaceId)
    return this.allowedState(message, state.users)
  }
  private async allowedState(message: MessageContext, users: string[]) {
    if (users.includes(message.message.sender.id)) return true
    try {
      const member = await this.ctx.im.requestMember(message.request)
      message.signal.throwIfAborted()
      return member?.active === true && member.role === 'owner'
    } catch {
      message.signal.throwIfAborted()
      return false
    }
  }
  async add(message: MessageContext, userId: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      message.signal.throwIfAborted()
      if (
        message.message.chat.type !== 'group' ||
        (await this.ctx.im.authenticate(message.request))?.workspaceId !== message.workspaceId
      )
        throw new AuthError(403, '无效的群命令上下文')
      const state = await this.get(message.workspaceId)
      if (!(await this.authorizeAdd(message)))
        throw new AuthError(403, '没有执行添加管理员命令的权限')
      if (state.users.includes(userId)) return
      try {
        message.signal.throwIfAborted()
        await this.set(message.workspaceId, [...state.users, userId], state.revision)
        return
      } catch (error) {
        if (!(error instanceof AuthError) || error.status !== 409) throw error
      }
    }
    throw new AuthError(409, '管理员名单正在被修改，请稍后重试')
  }
}
