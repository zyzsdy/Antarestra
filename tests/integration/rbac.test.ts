import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import type { Queries } from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import type { Config as DatabaseConfig } from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import type { AuthContext } from '@antarestra/rbac'
import local from '@antarestra/plugin-auth-local'
import type { Config } from '@antarestra/plugin-auth-local'
import type { Tables } from '../../plugins/definitions/rbac/src/schema.js'
import type { Tables as LocalTables } from '../../plugins/implementations/auth-local/src/schema.js'

const contexts: Context[] = []
const password = 'test-only-password-42'
const key = (value: string) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup(config: DatabaseConfig = { filename: ':memory:' }, options: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  const backend = await ctx.plugin(database, config)
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  const definition = await ctx.plugin(rbac)
  const providerId = `test-${randomUUID()}`
  const envName = `ANTARESTRA_TEST_ADMIN_${randomUUID().replaceAll('-', '')}`
  process.env[envName] = password
  const localConfig = {
    providerId,
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPasswordEnv: envName,
    ...options,
  }
  let implementation
  try {
    implementation = await ctx.plugin(local, localConfig)
  } finally {
    delete process.env[envName]
  }
  const url = `http://127.0.0.1:${ctx.server.address!.port}`
  const base = `/auth/local/${providerId}`
  const db = ctx.database.scope<Tables>(ctx, '@antarestra/rbac')
  const accounts = ctx.database.scope<LocalTables>(ctx, '@antarestra/plugin-auth-local')
  const request = async (
    path: string,
    body?: object,
    cookie?: string,
    method = 'POST',
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url}/api${path}`, {
      method: body ? method : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = async (email = 'admin@example.com') => {
    const response = await request(`${base}/login`, { email, password })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const register = (email = 'member@example.com') =>
    request(`${base}/register`, { email, password, displayName: '测试成员' })
  return {
    ctx,
    backend,
    definition,
    implementation,
    localConfig,
    providerId,
    url,
    base,
    db,
    accounts,
    request,
    login,
    register,
  }
}

const backends: { name: string; config: DatabaseConfig; enabled: boolean }[] = [
  { name: 'SQLite', config: { filename: ':memory:' }, enabled: true },
  {
    name: 'PostgreSQL',
    config: { type: 'postgresql', urlEnv: 'ANTARESTRA_TEST_POSTGRES' },
    enabled: !!process.env.ANTARESTRA_TEST_POSTGRES,
  },
  {
    name: 'MySQL',
    config: { type: 'mysql', urlEnv: 'ANTARESTRA_TEST_MYSQL' },
    enabled: !!process.env.ANTARESTRA_TEST_MYSQL,
  },
]
for (const backend of backends)
  describe.skipIf(!backend.enabled)(`RBAC 与 local ${backend.name} 真实数据库`, () => {
    it('注册、登录、管理员角色分配、立即撤权、禁用与注销形成完整闭环', async () => {
      const app = await setup(backend.config)
      expect((await app.request('/auth/me')).status).toBe(401)
      expect((await app.request('/health')).status).toBe(200)
      expect((await app.register()).status).toBe(201)
      expect((await app.register('MEMBER@example.com')).status).toBe(409)
      const member = await app.login('member@example.com')
      const admin = await app.login()
      const account = await app.accounts
        .selectFrom('account')
        .selectAll()
        .where('instance_id', '=', app.providerId)
        .where('email', '=', 'member@example.com')
        .executeTakeFirstOrThrow()
      expect(account.password_hash).toMatch(/^scrypt:/)
      expect(account.password_hash).not.toContain(password)
      const session = await app.db
        .selectFrom('session')
        .selectAll()
        .where('identity_id', '=', account.identity_id)
        .executeTakeFirstOrThrow()
      expect(session.token_hash).toBe(key(member.split('=')[1]!))
      expect((await app.request(`${app.base}/users`, undefined, member)).status).toBe(403)
      const users = await app.request(`${app.base}/users`, undefined, admin)
      expect(users.status).toBe(200)
      expect(await users.text()).not.toContain('password_hash')
      const roleId = `manager-${randomUUID()}`
      expect(
        (
          await app.request(
            `/rbac/roles/${roleId}`,
            { name: '用户管理员', permissions: ['identity.local.manage'] },
            admin,
            'PUT',
          )
        ).status,
      ).toBe(200)
      expect(
        (
          await app.request(
            `/rbac/bindings/${account.principal_id}`,
            { roleId, scope: 'system', enabled: true },
            member,
            'PUT',
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await app.request(
            `/rbac/bindings/${account.principal_id}`,
            { roleId, scope: 'system', enabled: true },
            admin,
            'PUT',
          )
        ).status,
      ).toBe(200)
      expect((await app.request(`${app.base}/users`, undefined, member)).status).toBe(200)
      expect(
        (
          await app.request(
            '/rbac/roles/administrator',
            { name: '窃取权限', permissions: [] },
            member,
            'PUT',
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await app.request(
            `/rbac/bindings/${account.principal_id}`,
            { roleId, scope: 'system', enabled: false },
            admin,
            'PUT',
          )
        ).status,
      ).toBe(200)
      expect((await app.request(`${app.base}/users`, undefined, member)).status).toBe(403)
      expect(
        (
          await app.request(
            `${app.base}/users/${account.id}/status`,
            { status: 'disabled' },
            admin,
            'PUT',
          )
        ).status,
      ).toBe(200)
      expect((await app.request('/auth/me', undefined, member)).status).toBe(401)
      expect(
        (await app.request(`${app.base}/login`, { email: 'member@example.com', password })).status,
      ).toBe(401)
      expect(
        (
          await app.request(
            `${app.base}/users/${account.id}/status`,
            { status: 'active' },
            admin,
            'PUT',
          )
        ).status,
      ).toBe(200)
      expect((await app.request('/auth/me', undefined, member)).status).toBe(401)
      const fresh = await app.login('member@example.com')
      expect((await app.request('/auth/logout', {}, fresh)).status).toBe(200)
      expect((await app.request('/auth/me', undefined, fresh)).status).toBe(401)
    }, 30_000)
  })

describe('认证边界与生命周期', () => {
  it('API 根路径不能绕过认证，重复提供者和权限声明被拒绝', async () => {
    const app = await setup()
    app.ctx.server.route(app.ctx, 'GET', '/', (http) => {
      http.body = '受保护根路由'
    })
    expect((await app.request('')).status).toBe(401)
    const admin = await app.login()
    expect((await app.request('', undefined, admin)).status).toBe(200)
    await expect(app.ctx.rbac.registerProvider(app.ctx, app.providerId, 'other')).rejects.toThrow(
      '重复',
    )
    expect(() => app.ctx.rbac.registerPermission(app.ctx, 'identity.local.manage', '重复')).toThrow(
      '重复',
    )
    expect(
      (
        await app.request(
          '/rbac/roles/ADMINISTRATOR',
          { name: '篡改管理员', permissions: [] },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await app.request(
          '/rbac/roles/administrator',
          { name: '篡改管理员', permissions: [] },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(403)
  })

  it('错误凭据不会签发会话，认证请求触发限流', async () => {
    const app = await setup()
    for (const address of ['admin@example.com', 'missing@example.com']) {
      const response = await app.request(`${app.base}/login`, {
        email: address,
        password: 'wrong-password-42',
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: '邮箱或密码错误' })
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    for (let attempt = 0; attempt < 18; attempt++)
      await app.request(`${app.base}/login`, { email: 'invalid', password })
    expect(
      (await app.request(`${app.base}/login`, { email: 'admin@example.com', password })).status,
    ).toBe(429)
    expect(await app.db.selectFrom('session').selectAll().execute()).toEqual([])
  })

  it('拒绝跨站、非 JSON、伪造令牌和超大请求，不公开密码与 Cookie 令牌', async () => {
    const app = await setup()
    const body = { email: 'admin@example.com', password }
    expect(
      (
        await app.request(`${app.base}/login`, body, undefined, 'POST', {
          Origin: 'https://attacker.example',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`${app.base}/login`, body, undefined, 'POST', {
          'Content-Type': 'text/plain',
        })
      ).status,
    ).toBe(415)
    expect(
      (await app.request(`${app.base}/login`, { ...body, padding: 'x'.repeat(17000) })).status,
    ).toBe(413)
    expect((await app.request('/auth/me', undefined, 'antarestra_session=forged')).status).toBe(401)
    const response = await app.request(`${app.base}/login`, body)
    expect(response.headers.get('set-cookie')).toMatch(/httponly/i)
    expect(response.headers.get('set-cookie')).toMatch(/samesite=strict/i)
    expect(await response.text()).not.toContain('token')
    const page = await fetch(`${app.url}${app.base}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('权限范围精确匹配，未声明、过期角色绑定、过期会话一律拒绝', async () => {
    const app = await setup()
    await app.register()
    const cookie = await app.login('member@example.com')
    const { auth } = (await (await app.request('/auth/me', undefined, cookie)).json()) as {
      auth: AuthContext
    }
    const release = app.ctx.rbac.registerPermission(app.ctx, 'conversation.read', '读取空间会话')
    await app.db
      .insertInto('role')
      .values({ id: 'reader', name: '读取', status: 'active' })
      .execute()
    await app.db
      .insertInto('role_permission')
      .values({ role_id: 'reader', permission: 'conversation.read' })
      .execute()
    await app.db
      .insertInto('binding')
      .values({
        principal_id: auth.principalId,
        role_id: 'reader',
        scope: 'WorkspaceA',
        scope_key: key('WorkspaceA'),
        source: 'test',
        expires_at: null,
      })
      .execute()
    expect(await app.ctx.rbac.can(auth, 'conversation.read', 'WorkspaceA')).toBe(true)
    expect(await app.ctx.rbac.can(auth, 'conversation.read', 'workspacea')).toBe(false)
    expect(await app.ctx.rbac.can(auth, 'conversation.read', 'WorkspaceB')).toBe(false)
    expect(await app.ctx.rbac.can(auth, 'conversation.read')).toBe(false)
    expect(await app.ctx.rbac.can(auth, 'unknown')).toBe(false)
    await app.db
      .updateTable('binding')
      .set({ expires_at: Date.now() - 1 })
      .execute()
    expect(await app.ctx.rbac.can(auth, 'conversation.read', 'WorkspaceA')).toBe(false)
    await app.db.updateTable('binding').set({ expires_at: null }).execute()
    await release()
    expect(await app.ctx.rbac.can(auth, 'conversation.read', 'WorkspaceA')).toBe(false)
    await app.db
      .updateTable('session')
      .set({ expires_at: Date.now() - 1 })
      .execute()
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(401)
  })

  it('多个认证实例独立，卸载撤销旧会话，重载保留主体且旧句柄失效', async () => {
    const app = await setup()
    const second = await app.ctx.plugin(local, { providerId: 'second', allowRegistration: true })
    await app.register()
    expect(
      (
        await app.request('/auth/local/second/register', {
          email: 'member@example.com',
          password,
          displayName: '另一个主体',
        })
      ).status,
    ).toBe(201)
    const firstCookie = await app.login('member@example.com')
    const secondLogin = await app.request('/auth/local/second/login', {
      email: 'member@example.com',
      password,
    })
    const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0]!
    const { auth: firstAuth } = (await (
      await app.request('/auth/me', undefined, firstCookie)
    ).json()) as { auth: AuthContext }
    const { auth: secondAuth } = (await (
      await app.request('/auth/me', undefined, secondCookie)
    ).json()) as { auth: AuthContext }
    expect(firstAuth.principalId).not.toBe(secondAuth.principalId)
    await app.implementation.dispose()
    expect((await app.request('/auth/me', undefined, firstCookie)).status).toBe(401)
    expect((await app.request('/auth/me', undefined, secondCookie)).status).toBe(200)
    expect(await app.ctx.rbac.principal(firstAuth.principalId)).toBeDefined()
    await app.ctx.plugin(local, app.localConfig)
    expect((await app.request('/auth/me', undefined, firstCookie)).status).toBe(401)
    expect(
      (await app.request('/auth/me', undefined, await app.login('member@example.com'))).status,
    ).toBe(200)
    await second.dispose()
    expect((await fetch(`${app.url}/auth/local/second`)).status).toBe(404)
  })

  it('跨插件事务整体回滚，结束后的查询拒绝执行', async () => {
    const app = await setup()
    let retained: Queries<Tables> | undefined
    const before = await app.db.selectFrom('principal').selectAll().execute()
    const owner = await app.ctx.plugin(() => {})
    const handle = await app.ctx.rbac.registerProvider(
      owner.ctx,
      'transaction-test',
      'test-provider',
    )
    await expect(
      app.ctx.database.transaction(app.ctx, async (transaction) => {
        retained = transaction.scope<Tables>(app.ctx, '@antarestra/rbac')
        await handle.provision(transaction, 'new-subject', '待回滚主体')
        await transaction
          .scope<LocalTables>(app.ctx, '@antarestra/plugin-auth-local')
          .insertInto('account')
          .values({
            id: 'rollback',
            instance_id: 'transaction-test',
            email: 'rollback@example.com',
            email_key: key('rollback@example.com'),
            password_hash: 'not-a-real-password',
            identity_id: 'rollback',
            principal_id: 'rollback',
            created_at: Date.now(),
          })
          .execute()
        throw new Error('中断注册')
      }),
    ).rejects.toThrow('中断注册')
    expect(await app.db.selectFrom('principal').selectAll().execute()).toEqual(before)
    expect(
      await app.accounts.selectFrom('account').selectAll().where('id', '=', 'rollback').execute(),
    ).toEqual([])
    expect(() => retained!.selectFrom('principal')).toThrow('事务已结束')
    await owner.dispose()
    await expect(handle.issue('new-subject')).rejects.toThrow()
  })

  it('并发重复注册只产生一个主体，关闭注册后请求被拒绝', async () => {
    const app = await setup()
    const before = await app.db.selectFrom('principal').selectAll().execute()
    const responses = await Promise.all([app.register(), app.register()])
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await app.db.selectFrom('principal').selectAll().execute()).toHaveLength(
      before.length + 1,
    )
    const closed = await app.ctx.plugin(local, { providerId: 'closed', allowRegistration: false })
    expect(
      (
        await app.request('/auth/local/closed/register', {
          email: 'a@example.com',
          password,
          displayName: '关闭注册',
        })
      ).status,
    ).toBe(403)
    await closed.dispose()
  })

  it('数据库依赖卸载后认证路由与服务撤销', async () => {
    const app = await setup()
    const cookie = await app.login()
    const service = app.ctx.rbac
    await app.backend.dispose()
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(404)
    await expect(service.authenticate(cookie.split('=')[1])).rejects.toThrow()
    expect((await fetch(`${app.url}${app.base}`)).status).toBe(404)
  })
})
