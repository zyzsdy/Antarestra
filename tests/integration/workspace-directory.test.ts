import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac, { type WorkspaceSummary } from '@antarestra/rbac'
import type { Tables } from '../../plugins/definitions/rbac/src/schema.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  const backend = await ctx.plugin(database, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  const owner = await ctx.plugin({ inject: ['rbac'], apply() {} })
  return { ctx, owner, backend }
}

async function directory(ctx: Context) {
  const rows: WorkspaceSummary[] = []
  for await (const row of ctx.rbac.workspaceDirectory()) rows.push(row)
  return rows
}

it('按来源分页聚合个人、团队与群空间，跨通道相同空间去重且不授予访问权限', async () => {
  const { ctx, owner } = await setup()
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: `tenant:${String(index).padStart(3, '0')}`,
    label: `企业空间·${index}`,
  }))
  const list = vi.fn(async (offset: number, limit: number) => rows.slice(offset, offset + limit))
  ctx.rbac.registerRequestSource(owner.ctx, 'sso', {
    id: 'enterprise',
    resolve: async () => undefined,
    listWorkspaces: list,
  })
  ctx.rbac.registerRequestSource(owner.ctx, 'im', {
    id: 'groups',
    resolve: async () => undefined,
    listWorkspaces: async () => [rows[0]!, { id: 'group:42', label: '群聊·42' }],
  })
  ctx.rbac.registerRequestSource(owner.ctx, 'legacy', {
    id: 'without-directory',
    resolve: async () => undefined,
  })
  expect(await directory(ctx)).toEqual([...rows, { id: 'group:42', label: '群聊·42' }])
  expect(list.mock.calls).toEqual([
    [0, 100],
    [100, 100],
  ])
  ctx.rbac.registerPermission(ctx, 'test.directory.use', '目录权限测试', ['user'])
  await expect(
    ctx.rbac.authorizeRequest('sso', { workspaceId: rows[0]!.id }, 'test.directory.use'),
  ).rejects.toMatchObject({ status: 401 })
  await owner.dispose()
  expect(await directory(ctx)).toEqual([])
})

it('来源故障、名称冲突和重复分页明确报错，不能静默丢失目录或无限翻页', async () => {
  const { ctx, owner } = await setup()
  const row = { id: 'team:42', label: '团队·42' }
  const release = ctx.rbac.registerRequestSource(owner.ctx, 'team', {
    id: 'primary',
    resolve: async () => undefined,
    listWorkspaces: async () => [row],
  })
  const conflict = ctx.rbac.registerRequestSource(owner.ctx, 'team', {
    id: 'conflict',
    resolve: async () => undefined,
    listWorkspaces: async () => [{ ...row, label: '另一团队' }],
  })
  await expect(directory(ctx)).rejects.toThrow('名称冲突')
  await conflict()
  await release()
  const duplicate = ctx.rbac.registerRequestSource(owner.ctx, 'team', {
    id: 'repeated-page',
    resolve: async () => undefined,
    listWorkspaces: async () =>
      Array.from({ length: 100 }, (_, index) => ({ id: `team:${index}`, label: '团队' })),
  })
  await expect(directory(ctx)).rejects.toThrow('分页包含重复标识')
  await duplicate()
  ctx.rbac.registerRequestSource(owner.ctx, 'team', {
    id: 'broken',
    resolve: async () => undefined,
    listWorkspaces: async () => {
      throw new Error('目录数据库离线')
    },
  })
  await expect(directory(ctx)).rejects.toThrow('目录数据库离线')
})

it('枚举期间卸载来源会拒绝迟到结果，重新注册不受旧回收函数影响', async () => {
  const { ctx, owner } = await setup()
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<readonly WorkspaceSummary[]>()
  const release = ctx.rbac.registerRequestSource(owner.ctx, 'sso', {
    id: 'enterprise',
    resolve: async () => undefined,
    listWorkspaces: () => {
      started.resolve()
      return pending.promise
    },
  })
  const result = directory(ctx)
  const rejected = expect(result).rejects.toMatchObject({ status: 503 })
  await started.promise
  await owner.dispose()
  const replacement = await ctx.plugin({ inject: ['rbac'], apply() {} })
  const row = { id: 'org:new', label: '新组织' }
  ctx.rbac.registerRequestSource(replacement.ctx, 'sso', {
    id: 'enterprise',
    resolve: async () => undefined,
    listWorkspaces: async () => [row],
  })
  await release()
  pending.resolve([{ id: 'org:old', label: '旧组织' }])
  await rejected
  expect(await directory(ctx)).toEqual([row])
})

it('主体目录按认证实例隔离、去重和分页，保留停用账号且遵守句柄与数据库生命周期', async () => {
  const { ctx, owner, backend } = await setup()
  const provider = await ctx.rbac.registerProvider(owner.ctx, 'sso', 'test-sso')
  const other = await ctx.rbac.registerProvider(ctx, 'other', 'test-other')
  const principals = await ctx.database.transaction(ctx, async (transaction) => {
    const first = await provider.provision(transaction, 'first', '首位成员')
    const second = await provider.provision(transaction, 'second', '另一成员')
    await other.provision(transaction, 'foreign', '其他实例成员')
    const db = transaction.scope<Tables>(ctx, '@antarestra/rbac')
    await db
      .updateTable('principal')
      .set({ status: 'disabled' })
      .where('id', '=', first.principalId)
      .execute()
    await db
      .insertInto('identity')
      .values({
        id: 'linked-identity',
        principal_id: first.principalId,
        provider_id: 'sso',
        subject: 'alias',
        status: 'active',
      })
      .execute()
    return [first.principalId, second.principalId].sort()
  })
  expect((await provider.principals()).map((row) => row.id)).toEqual(principals)
  expect((await provider.principals(1, 1)).map((row) => row.id)).toEqual(principals.slice(1))
  await expect(provider.principals(-1)).rejects.toThrow('分页无效')
  await owner.dispose()
  await expect(provider.principals()).rejects.toThrow()
  const reloaded = await ctx.rbac.registerProvider(ctx, 'sso', 'test-sso')
  expect((await reloaded.principals()).map((row) => row.id)).toEqual(principals)
  const service = ctx.rbac
  await backend.dispose()
  await expect(reloaded.principals()).rejects.toThrow()
  await expect(service.workspaceDirectory().next()).rejects.toThrow()
})
