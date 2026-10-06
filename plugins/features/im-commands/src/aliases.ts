import { randomUUID } from 'node:crypto'
import type { Context } from '@antarestra/plugin-sdk'
import { defineMigration } from '@antarestra/database'
import { pluginId } from './admins.js'

export interface CommandAlias {
  name: string
  id: string
  target: string
  suffix: string
}
interface Tables {
  command_aliases: CommandAlias
  command_policies: { name: string; policy: string; revision: number }
}
export const aliasMigration = defineMigration({
  id: '003_command_aliases',
  steps: [
    {
      kind: 'createTable',
      table: 'command_aliases',
      columns: [
        { name: 'name', type: 'string', length: 200, primaryKey: true },
        { name: 'id', type: 'string', length: 36, notNull: true },
        { name: 'target', type: 'string', length: 200, notNull: true },
        { name: 'suffix', type: 'text', notNull: true },
      ],
    },
  ],
})

export class CommandAliases {
  constructor(private readonly ctx: Context) {}
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  list() {
    return this.db().selectFrom('command_aliases').selectAll().execute()
  }
  async create(name: string, target: string, suffix: string) {
    const alias = { name, target, suffix, id: randomUUID() }
    await this.db().insertInto('command_aliases').values(alias).execute()
    return alias
  }
  async remove(alias: CommandAlias) {
    await this.db().transaction(async (db) => {
      await db.deleteFrom('command_aliases').where('id', '=', alias.id).execute()
      await db.deleteFrom('command_policies').where('name', '=', aliasPolicyKey(alias)).execute()
    })
  }
}

export function aliasPolicyKey(alias: CommandAlias) {
  return `alias:${alias.id}`
}
