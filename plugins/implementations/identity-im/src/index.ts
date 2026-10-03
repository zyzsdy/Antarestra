import { createHash } from 'node:crypto'
import { Service, type Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineDatabasePlugin } from '@antarestra/database'
import { connectionKey, type IdentityInput, type ImIdentity } from '@antarestra/im'
import type { ProviderHandle } from '@antarestra/rbac'
import { migrations, pluginId, type Tables } from './schema.js'
export interface Config {
  providerId?: string
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const actorKey = (input: IdentityInput) =>
  hash([connectionKey(input.connection), input.message.sender.id])
const workspaceKey = (input: IdentityInput) =>
  `im:${hash([connectionKey(input.connection), input.message.chat.type, input.message.chat.id])}`
declare module '@antarestra/plugin-sdk' {
  interface Context {
    identityIm: IdentityImService
  }
}

export class IdentityImService extends Service<{ provider: ProviderHandle; providerId: string }> {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    ctx: Context,
    private readonly config: { provider: ProviderHandle; providerId: string },
  ) {
    super(ctx, 'identityIm')
    ctx.im.registerIdentity(ctx, {
      resolve: (input) => this.resolve(input),
      validate: (identity, input) => this.validate(identity, input),
      background: (actorId, workspaceId) => this.background(actorId, workspaceId),
    })
    ctx.rbac.registerRequestSource(ctx, 'im', {
      id: config.providerId,
      resolve: async (request) => {
        const identity = await ctx.im.authenticate(request)
        if (identity) return { ...identity, roles: ['user'] }
      },
      resolveBackground: async (actorId, workspaceId) => {
        const identity = await ctx.im.validateBackground(actorId, workspaceId)
        if (identity) return { ...identity, roles: ['user'] }
      },
    })
  }
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  private async resolve(input: IdentityInput): Promise<ImIdentity> {
    const perform = async () =>
      this.ctx.database.transaction(this.ctx, async (transaction) => {
        const db = transaction.scope<Tables>(this.ctx, pluginId)
        const id = actorKey(input),
          workspaceId = workspaceKey(input),
          key = connectionKey(input.connection)
        let actor = await db.selectFrom('actor').selectAll().where('id', '=', id).executeTakeFirst()
        if (!actor) {
          const provisioned = await this.config.provider.provision(
            transaction,
            id,
            (input.message.sender.name || input.message.sender.id).slice(0, 128),
          )
          actor = {
            id,
            principal_id: provisioned.principalId,
            connection_key: key,
            sender_id: input.message.sender.id,
          }
          await db.insertInto('actor').values(actor).execute()
        }
        let workspace = await db
          .selectFrom('workspace')
          .selectAll()
          .where('id', '=', workspaceId)
          .executeTakeFirst()
        if (!workspace) {
          workspace = {
            id: workspaceId,
            connection_key: key,
            connection_id: input.connection.id,
            platform: input.connection.platform,
            account_id: input.connection.accountId,
            tenant_id: input.connection.tenantId ?? '',
            chat_type: input.message.chat.type,
            chat_id: input.message.chat.id,
            label: `${input.connection.platform}·${input.message.chat.type === 'group' ? '群聊' : '私聊'}·${input.message.chatName || input.message.chat.id}`,
            active: 1,
          }
          await db.insertInto('workspace').values(workspace).execute()
        }
        await this.ctx.rbac.ensureWorkspace(
          this.ctx,
          { id: workspaceId, label: workspace.label },
          transaction,
        )
        const member = await db
          .selectFrom('member')
          .selectAll()
          .where('actor_id', '=', actor.principal_id)
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst()
        if (!member)
          await db
            .insertInto('member')
            .values({ actor_id: actor.principal_id, workspace_id: workspaceId, active: 1 })
            .execute()
        return { actorId: actor.principal_id, workspaceId, workspaceLabel: workspace.label }
      })
    const result = this.pending.catch(() => {}).then(perform)
    this.pending = result
    return result
  }
  private async validate(identity: ImIdentity, input: IdentityInput): Promise<boolean> {
    if (identity.workspaceId !== workspaceKey(input)) return false
    const actor = await this.db()
      .selectFrom('actor')
      .select('principal_id')
      .where('id', '=', actorKey(input))
      .where('principal_id', '=', identity.actorId)
      .executeTakeFirst()
    if (!actor) return false
    const member = await this.db()
      .selectFrom('member')
      .innerJoin('workspace', 'workspace.id', 'member.workspace_id')
      .select('workspace.id')
      .where('member.actor_id', '=', identity.actorId)
      .where('workspace.id', '=', identity.workspaceId)
      .where('member.active', '=', 1)
      .where('workspace.active', '=', 1)
      .executeTakeFirst()
    return (
      !!member && !!(await this.ctx.rbac.backgroundRoles(this.config.providerId, identity.actorId))
    )
  }
  private async background(actorId: string, workspaceId: string) {
    const actor = await this.db()
      .selectFrom('actor')
      .selectAll()
      .where('principal_id', '=', actorId)
      .executeTakeFirst()
    const workspace = await this.db()
      .selectFrom('workspace')
      .selectAll()
      .where('id', '=', workspaceId)
      .where('active', '=', 1)
      .executeTakeFirst()
    if (!actor || !workspace || actor.connection_key !== workspace.connection_key) return
    const input: IdentityInput = {
      connection: {
        id: workspace.connection_id,
        platform: workspace.platform,
        accountId: workspace.account_id,
        ...(workspace.tenant_id ? { tenantId: workspace.tenant_id } : {}),
        capabilities: [],
        status: 'online',
      },
      message: {
        id: 'background',
        chat: { type: workspace.chat_type, id: workspace.chat_id },
        sender: { id: actor.sender_id },
        segments: [],
      },
    }
    const identity = { actorId, workspaceId, workspaceLabel: workspace.label }
    if (!(await this.validate(identity, input))) return
    return { identity, input }
  }
  async setMemberActive(actorId: string, workspaceId: string, active: boolean) {
    await this.db()
      .updateTable('member')
      .set({ active: active ? 1 : 0 })
      .where('actor_id', '=', actorId)
      .where('workspace_id', '=', workspaceId)
      .execute()
  }
  async setWorkspaceActive(workspaceId: string, active: boolean) {
    await this.db()
      .updateTable('workspace')
      .set({ active: active ? 1 : 0 })
      .where('id', '=', workspaceId)
      .execute()
  }
}
export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['im', 'rbac'],
  async apply(ctx: Context, config: Config = {}) {
    config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), config)
    const providerId = config.providerId ?? 'im'
    const provider = await ctx.rbac.registerProvider(ctx, providerId, pluginId)
    // 仅迁移本插件已有映射；目录消费方不需要知道空间来自哪个插件。
    const db = ctx.database.scope<Tables>(ctx, pluginId)
    for (let offset = 0; ; offset += 100) {
      const rows = await db
        .selectFrom('workspace')
        .select(['id', 'label'])
        .orderBy('id')
        .offset(offset)
        .limit(100)
        .execute()
      for (const row of rows) await ctx.rbac.ensureWorkspace(ctx, row)
      if (rows.length < 100) break
    }
    await ctx.plugin(IdentityImService, { provider, providerId })
  },
})
