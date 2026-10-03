import { afterEach, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac, { type RequestIdentity, type WorkspaceSummary } from '@antarestra/rbac'
import Storage from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
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
  const definition = await ctx.plugin(rbac)
  const owner = await ctx.plugin({ inject: ['rbac'], apply() {} })
  return { ctx, owner, backend, definition }
}

async function directory(ctx: Context) {
  const rows: WorkspaceSummary[] = []
  for await (const row of ctx.rbac.workspaceDirectory()) rows.push(row)
  return rows
}

it('已有本地账号在升级时补入统一目录，未登录和停用账号均保留', async () => {
  const { ctx } = await setup()
  await ctx.plugin(WebUI)
  const config = { bootstrapEmail: 'directory-test', bootstrapPassword: 'directory-password-42' }
  const implementation = await ctx.plugin(local, config)
  const original = await directory(ctx)
  expect(original).toHaveLength(1)
  expect(original[0]!.id).toMatch(/^personal:/)
  const db = ctx.database.scope<Tables>(ctx, '@antarestra/rbac')
  expect(await db.selectFrom('session').selectAll().execute()).toEqual([])
  await implementation.dispose()
  await db.deleteFrom('workspace').execute()
  await db.updateTable('principal').set({ status: 'disabled' }).execute()
  await ctx.plugin(local, config)
  expect(await directory(ctx)).toEqual(original)
})

it('任意身份来源只实现正常解析，空间自动持久化，来源卸载后才加载文件服务仍可见', async () => {
  const { ctx, owner } = await setup()
  for (const source of ['oauth', 'zerotrust']) {
    ctx.rbac.registerRequestSource(owner.ctx, source, {
      id: source,
      resolve: async (request) =>
        request === 'verified'
          ? {
              actorId: `${source}:actor`,
              workspaceId: `${source}:workspace`,
              workspaceLabel: `${source}·成员空间`,
              roles: ['user'],
            }
          : undefined,
    })
    await ctx.rbac.resolveRequest(source, 'verified')
  }
  // 无认证流程的可信业务也通过统一空间接口创建，不依赖文件插件。
  await ctx.rbac.ensureWorkspace(owner.ctx, { id: 'project:42', label: '项目·42' })
  await owner.dispose()
  await ctx.plugin(Storage)
  await ctx.plugin(files)
  const spaces = await ctx.workspaceFile.spaces(1, '')
  expect(spaces.entries.map(({ id, label }) => ({ id, label }))).toEqual([
    { id: 'oauth:workspace', label: 'oauth·成员空间' },
    { id: 'project:42', label: '项目·42' },
    { id: 'zerotrust:workspace', label: 'zerotrust·成员空间' },
  ])
  await expect(
    ctx.workspaceFile.list({ workspaceId: 'oauth:workspace' }, '/', 1),
  ).rejects.toMatchObject({ status: 403 })
})

it('并发重复空间合并，缺省名称不覆盖正式名称，超过一页及核心重载仍完整保留', async () => {
  const { ctx, owner, definition } = await setup()
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: `tenant:${String(index).padStart(3, '0')}`,
    label: `企业空间·${index}`,
  }))
  for (const row of rows) await ctx.rbac.ensureWorkspace(owner.ctx, row)
  await Promise.all(
    Array.from({ length: 8 }, () =>
      ctx.rbac.ensureWorkspace(owner.ctx, { id: 'shared', label: '共享空间' }),
    ),
  )
  await ctx.rbac.ensureWorkspace(owner.ctx, { id: 'shared' })
  expect(await directory(ctx)).toEqual([{ id: 'shared', label: '共享空间' }, ...rows])
  const old = ctx.rbac
  await definition.dispose()
  await expect(old.workspaceDirectory().next()).rejects.toThrow('已卸载')
  await ctx.plugin(rbac)
  expect(await directory(ctx)).toEqual([{ id: 'shared', label: '共享空间' }, ...rows])
})

it('空间与业务数据同事务提交或回滚，创建不授予成员资格或权限', async () => {
  const { ctx, owner } = await setup()
  const provider = await ctx.rbac.registerProvider(owner.ctx, 'organization', 'test-organization')
  await expect(
    ctx.database.transaction(owner.ctx, async (transaction) => {
      await provider.provision(transaction, 'first', '组织成员')
      await ctx.rbac.ensureWorkspace(
        owner.ctx,
        { id: 'organization:42', label: '组织·42' },
        transaction,
      )
      throw new Error('业务创建失败')
    }),
  ).rejects.toThrow('业务创建失败')
  expect(await provider.principals()).toEqual([])
  expect(await directory(ctx)).toEqual([])
  await ctx.database.transaction(owner.ctx, async (transaction) => {
    await provider.provision(transaction, 'first', '组织成员')
    await ctx.rbac.ensureWorkspace(
      owner.ctx,
      { id: 'organization:42', label: '组织·42' },
      transaction,
    )
  })
  expect(await directory(ctx)).toEqual([{ id: 'organization:42', label: '组织·42' }])
  ctx.rbac.registerRequestSource(owner.ctx, 'organization', {
    id: 'test',
    resolve: async () => undefined,
  })
  ctx.rbac.registerPermission(ctx, 'test.directory.use', '目录权限测试', ['user'])
  await expect(
    ctx.rbac.authorizeRequest(
      'organization',
      { workspaceId: 'organization:42' },
      'test.directory.use',
    ),
  ).rejects.toMatchObject({ status: 401 })
})

it('伪造、歧义、匿名和来源卸载后的迟到身份不能登记空间', async () => {
  const { ctx, owner } = await setup()
  const identity: RequestIdentity = { actorId: 'actor', workspaceId: 'private:42', roles: ['user'] }
  ctx.rbac.registerRequestSource(owner.ctx, 'web', {
    id: 'one',
    resolve: async (request) => (request === 'verified' ? identity : undefined),
  })
  await ctx.rbac.resolveRequest('web', { workspaceId: identity.workspaceId })
  expect(await directory(ctx)).toEqual([])
  const release = ctx.rbac.registerRequestSource(owner.ctx, 'web', {
    id: 'two',
    resolve: async () => identity,
  })
  await expect(ctx.rbac.resolveRequest('web', 'verified')).rejects.toThrow('歧义')
  expect(await directory(ctx)).toEqual([])
  await release()
  ctx.rbac.registerRequestSource(owner.ctx, 'anonymous', {
    id: 'guest',
    resolve: async () => ({ actorId: null, workspaceId: 'anonymous:42', roles: ['guest'] }),
  })
  await ctx.rbac.resolveRequest('anonymous', undefined)
  expect(await directory(ctx)).toEqual([])
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<RequestIdentity>()
  ctx.rbac.registerRequestSource(owner.ctx, 'slow', {
    id: 'slow',
    resolve: () => {
      started.resolve()
      return pending.promise
    },
  })
  const rejected = expect(ctx.rbac.resolveRequest('slow', undefined)).rejects.toMatchObject({
    status: 503,
  })
  await started.promise
  await owner.dispose()
  pending.resolve(identity)
  await rejected
  expect(await directory(ctx)).toEqual([])
  await expect(ctx.rbac.ensureWorkspace(owner.ctx, { id: 'stale' })).rejects.toThrow()
})

it('后台身份自动登记空间，重复解析和无名称的代理入口保留原名称', async () => {
  const { ctx, owner } = await setup()
  ctx.rbac.registerPermission(ctx, 'test.background.use', '后台测试', ['user'])
  let label = '组织空间'
  ctx.rbac.registerRequestSource(owner.ctx, 'background', {
    id: 'test',
    resolve: async () => undefined,
    resolveBackground: async (actorId, workspaceId) => ({
      actorId,
      workspaceId,
      workspaceLabel: label,
      roles: ['user'],
    }),
  })
  await ctx.rbac.authorizeBackground('background', 'actor', 'background:42', 'test.background.use')
  label = '组织新名称'
  await ctx.rbac.authorizeBackground('background', 'actor', 'background:42', 'test.background.use')
  ctx.rbac.registerRequestSource(owner.ctx, 'proxy', {
    id: 'test',
    resolve: async () => ({ actorId: 'actor', workspaceId: 'background:42', roles: ['user'] }),
  })
  expect(await ctx.rbac.resolveRequest('proxy', undefined)).toMatchObject({ workspaceLabel: label })
  expect(await directory(ctx)).toEqual([{ id: 'background:42', label }])
})

it('主体按认证实例隔离，空间目录与旧句柄遵守数据库生命周期', async () => {
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
  const service = ctx.rbac
  await backend.dispose()
  await expect(service.workspaceDirectory().next()).rejects.toThrow()
})
