import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineMigration } from '@antarestra/database'
import { AuthError } from '@antarestra/rbac'
import { pluginId } from './admins.js'

export interface CommandList {
  mode: 'whitelist' | 'blacklist'
  ids: string[]
}
export interface CommandPolicy {
  access: 'user' | 'bot-admin'
  group: CommandList
  private: CommandList
}
export interface CommandPolicyState {
  policy: CommandPolicy
  revision: number
}
export interface CommandSummary extends CommandPolicyState {
  name: string
  description: string
  usage?: string
  alias?: { id: string; target: string; available: boolean }
}
interface Tables {
  command_policies: { name: string; policy: string; revision: number }
}
export const policyMigration = defineMigration({
  id: '002_command_policies',
  steps: [
    {
      kind: 'createTable',
      table: 'command_policies',
      columns: [
        { name: 'name', type: 'string', length: 200, primaryKey: true },
        { name: 'policy', type: 'text', notNull: true },
        { name: 'revision', type: 'integer', notNull: true },
      ],
    },
  ],
})

export class CommandPolicies {
  constructor(private readonly ctx: Context) {}
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  async get(name: string, access: CommandPolicy['access'] = 'user'): Promise<CommandPolicyState> {
    const row = await this.db()
      .selectFrom('command_policies')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst()
    if (row) return { policy: JSON.parse(row.policy) as CommandPolicy, revision: row.revision }
    return {
      policy: {
        access,
        group: { mode: 'whitelist', ids: [] },
        private: { mode: 'whitelist', ids: [] },
      },
      revision: 0,
    }
  }
  async set(name: string, input: unknown, expected: unknown): Promise<CommandPolicyState> {
    if (!Number.isSafeInteger(expected) || Number(expected) < 0)
      throw new AuthError(400, '修订号无效')
    let policy: CommandPolicy
    try {
      policy = schemaConfig<CommandPolicy>(new URL('../policy.schema.json', import.meta.url), input)
    } catch {
      throw new AuthError(
        400,
        '请提供授权级别及完整的群聊、私聊名单；每项 ID 不得包含空白，最多 200 字符，每份名单最多 1000 项。',
      )
    }
    const row = { name, policy: JSON.stringify(policy), revision: Number(expected) + 1 }
    if (expected === 0) {
      try {
        await this.db().insertInto('command_policies').values(row).execute()
      } catch (error) {
        if ((await this.get(name)).revision > 0)
          throw new AuthError(409, '命令权限已变化，请重新读取后再保存')
        throw error
      }
    } else {
      const result = await this.db()
        .updateTable('command_policies')
        .set(row)
        .where('name', '=', name)
        .where('revision', '=', Number(expected))
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1)
        throw new AuthError(409, '命令权限已变化，请重新读取后再保存')
    }
    return { policy, revision: row.revision }
  }
}
