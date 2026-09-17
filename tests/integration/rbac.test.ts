import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import type { Queries } from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import type { Config as DatabaseConfig } from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import WebUI from '@antarestra/webui'
import rbac from '@antarestra/rbac'
import type { AuthContext } from '@antarestra/rbac'
import local from '@antarestra/plugin-auth-local'
import * as chatWebui from '@antarestra/plugin-chat-webui'
import * as adminConsole from '@antarestra/plugin-admin-console'
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
  await ctx.plugin(WebUI)
  const definition = await ctx.plugin(rbac)
  const providerId = `test-${randomUUID()}`
  const localConfig = {
    providerId,
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: password,
    ...options,
  }
  const implementation = await ctx.plugin(local, localConfig)
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
    config: { type: 'postgresql', url: process.env.ANTARESTRA_TEST_POSTGRES ?? '' },
    enabled: !!process.env.ANTARESTRA_TEST_POSTGRES,
  },
  {
    name: 'MySQL',
    config: { type: 'mysql', url: process.env.ANTARESTRA_TEST_MYSQL ?? '' },
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
  it('登录附带系统权限快照，空间授权不混入菜单权限，旧快照不能绕过真实 API', async () => {
    const app = await setup()
    const consolePlugin = await app.ctx.plugin(adminConsole)
    await app.register()
    const member = await app.login('member@example.com')
    const response = await app.request(`${app.base}/login`, {
      email: 'admin@example.com',
      password,
    })
    const login = await response.json()
    const admin = response.headers.get('set-cookie')!.split(';')[0]!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(login.session.permissions).toEqual(
      expect.arrayContaining(['admin.console.view', 'identity.local.manage']),
    )
    expect(login.session).not.toHaveProperty('token')
    expect(login.session).not.toHaveProperty('sessionId')
    expect(login.session.expiresAt).toBe(login.expiresAt)
    const me = async (cookie: string) => (await app.request('/auth/me', undefined, cookie)).json()
    expect((await me(admin)).session).toEqual(login.session)
    expect((await me(member)).session.permissions).not.toContain('admin.console.view')
    expect((await app.request('/admin-console/session', undefined, admin)).status).toBe(404)
    const { auth } = await me(member)
    expect(
      (
        await app.request(
          '/rbac/roles/console-reader',
          {
            name: '后台访客',
            permissions: ['admin.console.view', 'identity.local.manage'],
          },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    await app.db
      .insertInto('binding')
      .values({
        principal_id: auth.principalId,
        role_id: 'console-reader',
        scope: 'personal:' + auth.principalId,
        scope_key: key('personal:' + auth.principalId),
        source: 'test',
        expires_at: null,
      })
      .execute()
    expect((await me(member)).session.permissions).not.toContain('admin.console.view')
    expect((await app.request(app.base + '/users', undefined, member)).status).toBe(403)
    const binding = '/rbac/bindings/' + auth.principalId
    expect(
      (
        await app.request(
          binding,
          { roleId: 'console-reader', scope: 'system', enabled: true },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    const oldSnapshot = (await me(member)).session
    expect(oldSnapshot.permissions).toEqual(
      expect.arrayContaining(['admin.console.view', 'identity.local.manage']),
    )
    expect((await app.request(app.base + '/users', undefined, member)).status).toBe(200)
    expect(
      (
        await app.request(
          binding,
          { roleId: 'console-reader', scope: 'system', enabled: false },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect(oldSnapshot.permissions).toContain('identity.local.manage')
    expect((await app.request(app.base + '/users', undefined, member)).status).toBe(403)
    expect((await me(member)).session.permissions).not.toContain('identity.local.manage')
    await consolePlugin.dispose()
    expect((await me(admin)).session.permissions).not.toContain('admin.console.view')
    expect(app.ctx.webui.getEntries().some((entry) => entry.id === 'admin-console')).toBe(false)
    await app.ctx.plugin(adminConsole)
    expect((await me(admin)).session.permissions).toContain('admin.console.view')
    expect((await app.request('/auth/logout', {}, admin)).status).toBe(200)
    expect((await app.request(app.base + '/users', undefined, admin)).status).toBe(401)
  })
  it('聊天入口验证 Web 身份、默认角色、稳定个人空间与跨空间隔离', async () => {
    const app = await setup()
    const chat = await app.ctx.plugin(chatWebui)
    const guest = await app.request('/chat-webui/session')
    expect(guest.status).toBe(401)
    expect(await guest.json()).toMatchObject({ loginPath: `/auth/user/${app.providerId}/` })
    await app.register()
    const cookie = await app.login('member@example.com')
    const member = await (await app.request('/chat-webui/session', undefined, cookie)).json()
    expect(member).toMatchObject({ requestSource: 'web', roles: ['user'] })
    expect(member.workspaceId).toBe(`personal:${member.actorId}`)
    const adminCookie = await app.login()
    const admin = await (await app.request('/chat-webui/session', undefined, adminCookie)).json()
    expect(admin.roles).toEqual(['user', 'admin'])
    expect(admin.workspaceId).not.toBe(member.workspaceId)
    expect(
      (
        await app.request(
          `/chat-webui/session?workspaceId=${encodeURIComponent(member.workspaceId)}`,
          undefined,
          adminCookie,
        )
      ).status,
    ).toBe(403)
    const again = await app.login('member@example.com')
    expect(await (await app.request('/chat-webui/session', undefined, again)).json()).toMatchObject(
      { actorId: member.actorId, workspaceId: member.workspaceId },
    )
    const roles = await (await app.request('/rbac/roles', undefined, adminCookie)).json()
    expect(roles.permissions).toContainEqual({
      key: 'chat.webui.view',
      description: '使用Web聊天界面',
      defaultRoles: ['user', 'admin'],
    })
    await app.implementation.dispose()
    expect((await app.request('/chat-webui/session', undefined, cookie)).status).toBe(503)
    await chat.dispose()
    expect(app.ctx.webui.getEntries()).toEqual([])
  })

  it('自由请求通道、访客默认权限、权限拒绝与注册回收', async () => {
    const app = await setup()
    const owner = await app.ctx.plugin(() => {})
    const release = app.ctx.rbac.registerPermission(owner.ctx, 'readGroup', '读取群组', ['user'])
    app.ctx.rbac.registerPermission(owner.ctx, 'readWelcome', '读取欢迎信息', ['guest'])
    app.ctx.rbac.registerPermission(owner.ctx, 'adminOnly', '管理员功能', ['admin'])
    const provider = {
      id: 'groups',
      async resolve(request: unknown) {
        if (request !== 'verified-group') return
        return { actorId: 'group-member', workspaceId: 'group:42', roles: ['user'] as const }
      },
    }
    app.ctx.rbac.registerRequestSource(owner.ctx, 'telegram_group', provider)
    expect(() => app.ctx.rbac.registerRequestSource(owner.ctx, 'telegram_group', provider)).toThrow(
      '重复',
    )
    expect(
      await app.ctx.rbac.authorizeRequest('telegram_group', 'verified-group', 'readGroup'),
    ).toMatchObject({ actorId: 'group-member', workspaceId: 'group:42' })
    expect(
      await app.ctx.rbac.authorizeRequest('telegram_group', undefined, 'readWelcome'),
    ).toMatchObject({ actorId: null, roles: ['guest'] })
    await expect(
      app.ctx.rbac.authorizeRequest('telegram_group', undefined, 'readGroup'),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      app.ctx.rbac.authorizeRequest('telegram_group', 'verified-group', 'adminOnly'),
    ).rejects.toMatchObject({ status: 403 })
    await release()
    await expect(
      app.ctx.rbac.authorizeRequest('telegram_group', 'verified-group', 'readGroup'),
    ).rejects.toMatchObject({ status: 403 })
    await owner.dispose()
    await expect(
      app.ctx.rbac.resolveRequest('telegram_group', 'verified-group'),
    ).rejects.toMatchObject({ status: 503 })
  })

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
      expect(await response.json()).toEqual({ error: '登录名或密码错误' })
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
    const page = await fetch(`${app.url}/webui/entries.json`)
    expect(page.status).toBe(200)
    expect(await page.json()).toEqual([
      expect.objectContaining({
        id: 'auth-local-' + app.providerId,
        config: expect.objectContaining({ path: '/auth/user/' + app.providerId + '/' }),
      }),
    ])
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
    expect(
      JSON.stringify(await (await fetch(`${app.url}/webui/entries.json`)).json()),
    ).not.toContain('auth-local-second')
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
            password_change_required: 0,
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
    const defaultClosed = await app.ctx.plugin(local, { providerId: 'default-closed' })
    expect(
      (
        await app.request('/auth/local/default-closed/register', {
          loginName: 'a@example.com',
          password,
          displayName: '默认关闭注册',
        })
      ).status,
    ).toBe(403)
    await defaultClosed.dispose()
  })

  it('数据库依赖卸载后认证路由与服务撤销', async () => {
    const app = await setup()
    const cookie = await app.login()
    const service = app.ctx.rbac
    await app.backend.dispose()
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(404)
    await expect(service.authenticate(cookie.split('=')[1])).rejects.toThrow()
    expect(await (await fetch(`${app.url}/webui/entries.json`)).json()).toEqual([])
  })
})

describe('用户管理改版', () => {
  it('管理员创建和重置用户时生成初始密码，并强制用户修改后再访问其他 API', async () => {
    const app = await setup()
    const admin = await app.login()
    const created = await app.request(
      `${app.base}/users`,
      { loginName: 'new-user', displayName: '新用户', roleId: 'user' },
      admin,
    )
    expect(created.status).toBe(201)
    const credentials = await created.json()
    expect(credentials).toMatchObject({
      loginName: 'new-user',
      displayName: '新用户',
      loginUrl: `${app.url}/auth/user/${app.providerId}/`,
    })
    expect(credentials.initialPassword).toHaveLength(16)
    expect(credentials.initialPassword).toMatch(/[a-hj-np-z]/)
    expect(credentials.initialPassword).toMatch(/[2-9]/)
    expect(credentials.initialPassword).toMatch(/[~@#$%^&*:+\-=<>?/\\]/)
    expect(credentials.initialPassword).not.toMatch(/[oi10!A-Z]/)

    const login = await app.request(`${app.base}/login`, {
      loginName: 'NEW-USER',
      password: credentials.initialPassword,
    })
    expect(login.status).toBe(200)
    expect((await login.clone().json()).session.passwordChangeRequired).toBe(true)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(200)
    expect((await app.request('/health', undefined, cookie)).status).toBe(403)
    expect(
      (
        await app.request(
          `${app.base}/password`,
          { currentPassword: credentials.initialPassword, newPassword: 'new-secure-password-42' },
          cookie,
        )
      ).status,
    ).toBe(200)
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(200)
    expect((await app.request('/health', undefined, cookie)).status).toBe(200)

    const account = await app.accounts
      .selectFrom('account')
      .selectAll()
      .where('email', '=', 'new-user')
      .executeTakeFirstOrThrow()
    expect(account.password_change_required).toBe(0)
    const reset = await app.request(`${app.base}/users/${account.id}/reset-password`, {}, admin)
    expect(reset.status).toBe(200)
    const resetCredentials = await reset.json()
    expect(resetCredentials.initialPassword).not.toBe(credentials.initialPassword)
    expect((await app.request('/auth/me', undefined, cookie)).status).toBe(401)
    expect(
      (
        await app.request(`${app.base}/login`, {
          loginName: 'new-user',
          password: 'new-secure-password-42',
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(`${app.base}/login`, {
          loginName: 'new-user',
          password: resetCredentials.initialPassword,
        })
      ).status,
    ).toBe(200)
  })

  it('内置角色和默认权限可见，默认授权不落库，额外权限即时生效', async () => {
    const app = await setup()
    const admin = await app.login()
    const data = await (await app.request('/rbac/roles', undefined, admin)).json()
    expect(data.roles.map((role: { id: string }) => role.id).sort()).toEqual([
      'admin',
      'guest',
      'user',
    ])
    expect(data.grants).toEqual([])
    expect(data.permissions).toContainEqual({
      key: 'identity.local.manage',
      description: '查询、创建、重置密码、启用或禁用本地账号',
      defaultRoles: ['admin'],
    })
    expect(
      (
        await app.request(
          '/rbac/roles/admin',
          { name: '系统管理员', permissions: ['identity.local.manage', 'authz.role.manage'] },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect(await app.db.selectFrom('role_permission').selectAll().execute()).toEqual([])
    await app.register()
    const member = await app.login('member@example.com')
    expect(
      (
        await app.request(
          '/rbac/roles/user',
          { name: '普通用户', permissions: ['identity.local.manage'] },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect((await app.request(app.base + '/users', undefined, member)).status).toBe(200)
    expect(
      (await app.request('/rbac/roles/user', { name: '普通用户', permissions: [] }, admin, 'PUT'))
        .status,
    ).toBe(200)
    expect((await app.request(app.base + '/users', undefined, member)).status).toBe(403)
  })

  it('筛选先于分页，角色分配支持新 ID 并拒绝通过默认角色提权', async () => {
    const app = await setup()
    await app.register()
    const admin = await app.login()
    const member = await app.login('member@example.com')
    const account = await app.accounts
      .selectFrom('account')
      .selectAll()
      .where('email', '=', 'member@example.com')
      .executeTakeFirstOrThrow()
    const binding = `/rbac/bindings/${account.principal_id}`
    expect(
      (
        await app.request(
          binding,
          { roleId: 'operator', scope: 'system', enabled: true },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          '/rbac/roles/operator',
          { name: '运营人员', permissions: ['authz.binding.manage'] },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(
          binding,
          { roleId: 'admin', scope: 'system', enabled: true },
          member,
          'PUT',
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          binding,
          { roleId: 'admin', scope: 'other-space', enabled: true },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(403)
    const filtered = await (
      await app.request(
        app.base + '/users?q=' + encodeURIComponent('测试成员') + '&role=operator&status=active',
        undefined,
        admin,
      )
    ).json()
    expect(filtered.total).toBe(1)
    expect(filtered.users[0].roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'user', source: 'default' }),
        expect.objectContaining({ id: 'operator', source: 'manual' }),
      ]),
    )
    expect(
      (await (await app.request(app.base + '/users?q=missing', undefined, admin)).json()).total,
    ).toBe(0)
    expect(
      (await (await app.request(app.base + '/users?offset=50', undefined, admin)).json()).users,
    ).toEqual([])
    expect((await app.request(app.base + '/users?status=invalid', undefined, admin)).status).toBe(
      400,
    )
    expect(
      (
        await app.request(
          binding,
          { roleId: 'operator', scope: 'system', enabled: false },
          admin,
          'PUT',
        )
      ).status,
    ).toBe(200)
    expect(
      (await (await app.request(app.base + '/users?role=operator', undefined, admin)).json()).total,
    ).toBe(0)
  })

  it('旧管理员绑定与额外授权事务迁移且可重复执行', async () => {
    const app = await setup()
    const admin = await app.login()
    const me = await (await app.request('/auth/me', undefined, admin)).json()
    await app.db
      .insertInto('role')
      .values({ id: 'administrator', name: '旧管理员', status: 'active' })
      .execute()
    await app.db
      .updateTable('binding')
      .set({ role_id: 'administrator' })
      .where('principal_id', '=', me.auth.principalId)
      .execute()
    await app.db
      .insertInto('role_permission')
      .values([
        { role_id: 'administrator', permission: 'identity.local.manage' },
        { role_id: 'administrator', permission: 'custom.audit.view' },
      ])
      .execute()
    await app.ctx.rbac.initializeRoles()
    await app.ctx.rbac.initializeRoles()
    expect(
      await app.db.selectFrom('role').selectAll().where('id', '=', 'administrator').execute(),
    ).toEqual([])
    expect(await app.db.selectFrom('role_permission').selectAll().execute()).toEqual([
      { role_id: 'admin', permission: 'custom.audit.view' },
    ])
    expect(await app.ctx.rbac.defaultRoles(me.auth)).toEqual(['user', 'admin'])
  })
})

it('迁移同名旧自定义角色不会扩大已有成员权限', async () => {
  const app = await setup()
  await app.register()
  const member = await app.login('member@example.com')
  const me = await (await app.request('/auth/me', undefined, member)).json()
  await app.db.deleteFrom('role_migration').execute()
  await app.ctx.database.transaction(app.ctx, (transaction) =>
    app.ctx.rbac.grantRole(transaction, {
      principalId: me.auth.principalId,
      roleId: 'admin',
      scope: 'system',
      source: 'manual',
    }),
  )
  await app.ctx.rbac.initializeRoles()
  expect(await app.ctx.rbac.defaultRoles(me.auth)).toEqual(['user'])
  const bindings = await app.db
    .selectFrom('binding')
    .selectAll()
    .where('principal_id', '=', me.auth.principalId)
    .execute()
  expect(bindings[0]?.role_id).toMatch(/^legacy-admin-/)
  expect((await app.request(app.base + '/users', undefined, member)).status).toBe(403)
})

it('访客额外权限应用到可信请求通道，撤销后立即拒绝', async () => {
  const app = await setup()
  app.ctx.rbac.registerPermission(app.ctx, 'public.catalog.view', '查看公开目录', ['admin'])
  app.ctx.rbac.registerRequestSource(app.ctx, 'public-test', {
    id: 'anonymous',
    async resolve() {
      return undefined
    },
  })
  const admin = await app.login()
  await expect(
    app.ctx.rbac.authorizeRequest('public-test', {}, 'public.catalog.view'),
  ).rejects.toThrow('请先登录')
  expect(
    (
      await app.request(
        '/rbac/roles/guest',
        { name: '访客', permissions: ['public.catalog.view'] },
        admin,
        'PUT',
      )
    ).status,
  ).toBe(200)
  await expect(
    app.ctx.rbac.authorizeRequest('public-test', {}, 'public.catalog.view'),
  ).resolves.toMatchObject({ roles: ['guest'] })
  expect(
    (await app.request('/rbac/roles/guest', { name: '访客', permissions: [] }, admin, 'PUT'))
      .status,
  ).toBe(200)
  await expect(
    app.ctx.rbac.authorizeRequest('public-test', {}, 'public.catalog.view'),
  ).rejects.toThrow('请先登录')
})
