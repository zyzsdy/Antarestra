import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import type { DatabaseTransaction, Queries } from '@antarestra/database'
import type { HttpContext, Middleware } from '@antarestra/plugin-server'
import type { SessionSnapshot } from '@antarestra/contracts'
import { migrations, pluginId } from './schema.js'
import type { Principal, Tables } from './schema.js'
import { AuthError, errors, readJson, textField } from './http.js'

export { AuthError, readJson, textField } from './http.js'
export type { Principal } from './schema.js'
export interface AuthContext {
  readonly principalId: string
  readonly identityId: string
  readonly providerId: string
  readonly sessionId: string
  readonly channel: 'web' | 'api'
}
export interface ProviderHandle {
  provision(
    transaction: DatabaseTransaction,
    subject: string,
    displayName: string,
  ): Promise<{ principalId: string; identityId: string }>
  issue(subject: string): Promise<{ token: string; expiresAt: number }>
}
export interface Config {
  sessionHours?: number
}
export type DefaultRole = 'guest' | 'user' | 'admin'
export interface RequestIdentity {
  readonly actorId: string | null
  readonly workspaceId: string | null
  readonly roles: readonly DefaultRole[]
  readonly auth?: AuthContext
}
export interface RequestAccess extends RequestIdentity {
  readonly requestSource: string
}
export interface RequestSourceProvider {
  readonly id: string
  readonly loginPath?: string
  resolve(request: unknown): Promise<RequestIdentity | undefined>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const cookieName = 'antarestra_session'
const adminPermissions = [
  'identity.local.manage',
  'authz.role.manage',
  'authz.binding.manage',
] as const

declare module '@antarestra/plugin-sdk' {
  interface Context {
    rbac: RbacService
  }
}

export class RbacService extends Service<Config> {
  private readonly providers = new Map<string, { ready: boolean }>()
  private readonly permissions = new Map<
    string,
    { description: string; defaultRoles: readonly DefaultRole[] }
  >()
  private readonly sources = new Map<string, Map<string, RequestSourceProvider>>()
  private readonly publicPaths = new Set<string>()
  private readonly requests = new WeakMap<object, AuthContext>()
  private readonly hours: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'rbac')
    if (
      !config ||
      typeof config !== 'object' ||
      Object.keys(config).some((key) => key !== 'sessionHours')
    )
      throw new Error('RBAC 配置无效')
    this.hours = config.sessionHours ?? 24
    if (!Number.isFinite(this.hours) || this.hours <= 0 || this.hours > 720)
      throw new Error('会话有效期必须在 0 到 720 小时之间')
    for (const permission of adminPermissions)
      this.registerPermission(ctx, permission, '用户与权限管理', ['admin'])
    ctx.server.use(ctx, errors)
    ctx.server.use(ctx, async (http, next) => {
      if ((http.path !== '/api' && !http.path.startsWith('/api/')) || http.path === '/api/health')
        return next()
      if (this.publicPaths.has(`${http.method} ${http.path}`)) return next()
      const auth = await this.authenticate(this.token(http))
      if (!auth) throw new AuthError(401, '请先登录')
      this.requests.set(http, auth)
      await next()
    })
    ctx.effect(() => () => {
      this.providers.clear()
      this.permissions.clear()
      this.sources.clear()
      this.publicPaths.clear()
    })
    this.routes(ctx)
  }

  private db(transaction?: DatabaseTransaction): Queries<Tables> {
    this.ctx.fiber.assertActive()
    return transaction
      ? transaction.scope<Tables>(this.ctx, pluginId)
      : this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }

  registerPermission(
    owner: Context,
    permission: string,
    description: string,
    defaultRoles: readonly DefaultRole[] = [],
  ): () => Promise<void> {
    this.ctx.fiber.assertActive()
    if (!/^[a-z][a-zA-Z0-9_.]{0,127}$/.test(permission)) throw new Error('权限标识无效')
    if (
      !description.trim() ||
      defaultRoles.some((role) => !['guest', 'user', 'admin'].includes(role))
    )
      throw new Error('权限描述或默认角色无效')
    if (this.permissions.has(permission)) throw new Error(`权限重复注册：${permission}`)
    const declaration = { description, defaultRoles: [...new Set(defaultRoles)] }
    return owner.effect(() => {
      this.permissions.set(permission, declaration)
      return () => {
        if (this.permissions.get(permission) === declaration) this.permissions.delete(permission)
      }
    })
  }

  registerRequestSource(
    owner: Context,
    source: string,
    provider: RequestSourceProvider,
  ): () => Promise<void> {
    this.ctx.fiber.assertActive()
    if (!source.trim() || !provider.id.trim()) throw new Error('请求通道标识无效')
    if (
      provider.loginPath &&
      (!provider.loginPath.startsWith('/') ||
        provider.loginPath.startsWith('//') ||
        /[\\?#]/.test(provider.loginPath))
    )
      throw new Error('登录路径无效')
    const providers = this.sources.get(source) ?? new Map<string, RequestSourceProvider>()
    if (providers.has(provider.id)) throw new Error('请求通道提供者重复注册')
    return owner.effect(() => {
      this.sources.set(source, providers)
      providers.set(provider.id, provider)
      return () => {
        if (providers.get(provider.id) === provider) providers.delete(provider.id)
        if (!providers.size && this.sources.get(source) === providers) this.sources.delete(source)
      }
    })
  }

  loginPath(source: string, providerId?: string): string | undefined {
    if (providerId) return this.sources.get(source)?.get(providerId)?.loginPath
    return [...(this.sources.get(source)?.values() ?? [])].find((provider) => provider.loginPath)
      ?.loginPath
  }

  async resolveRequest(source: string, request: unknown): Promise<RequestAccess> {
    this.ctx.fiber.assertActive()
    const providers = this.sources.get(source)
    if (!providers?.size) throw new AuthError(503, '请求通道不可用')
    let identity: RequestIdentity | undefined
    for (const provider of providers.values()) {
      const result = await provider.resolve(request)
      this.ctx.fiber.assertActive()
      if (providers.get(provider.id) !== provider) throw new AuthError(503, '请求通道已卸载')
      if (!result) continue
      if (identity) throw new AuthError(403, '请求身份存在歧义')
      identity = result
    }
    if (this.sources.get(source) !== providers || !providers.size)
      throw new AuthError(503, '请求通道已卸载')
    return Object.freeze({
      requestSource: source,
      ...(identity ?? { actorId: null, workspaceId: null, roles: ['guest'] as const }),
    })
  }

  async authorizeRequest(
    source: string,
    request: unknown,
    permission: string,
  ): Promise<RequestAccess> {
    const identity = await this.resolveRequest(source, request)
    const declaration = this.permissions.get(permission)
    if (!declaration) throw new AuthError(403, '权限未注册')
    const allowed =
      identity.roles.some((role) => declaration.defaultRoles.includes(role)) ||
      (identity.auth &&
        identity.workspaceId &&
        (await this.can(identity.auth, permission, identity.workspaceId)))
    if (!allowed)
      throw new AuthError(
        identity.actorId ? 403 : 401,
        identity.actorId ? '没有操作权限' : '请先登录',
      )
    return identity
  }

  async defaultRoles(auth: AuthContext): Promise<readonly DefaultRole[]> {
    const active = await this.db()
      .selectFrom('session')
      .innerJoin('identity', 'identity.id', 'session.identity_id')
      .innerJoin('principal', 'principal.id', 'identity.principal_id')
      .innerJoin('provider', 'provider.id', 'identity.provider_id')
      .select('session.id')
      .where('session.id', '=', auth.sessionId)
      .where('identity.id', '=', auth.identityId)
      .where('principal.id', '=', auth.principalId)
      .where('provider.id', '=', auth.providerId)
      .where('session.expires_at', '>', Date.now())
      .where('principal.status', '=', 'active')
      .where('identity.status', '=', 'active')
      .where('provider.status', '=', 'active')
      .executeTakeFirst()
    if (!active || !this.providers.get(auth.providerId)?.ready) throw new AuthError(401, '请先登录')
    const admin = await this.db()
      .selectFrom('binding')
      .innerJoin('role', 'role.id', 'binding.role_id')
      .select('role.id')
      .where('binding.principal_id', '=', auth.principalId)
      .where('role.id', '=', 'administrator')
      .where('role.status', '=', 'active')
      .where('binding.scope_key', '=', hash('system'))
      .where((eb) =>
        eb.or([eb('binding.expires_at', 'is', null), eb('binding.expires_at', '>', Date.now())]),
      )
      .executeTakeFirst()
    return admin ? ['user', 'admin'] : ['user']
  }

  publicRoute(owner: Context, method: string, path: string): () => Promise<void> {
    this.ctx.fiber.assertActive()
    const key = `${method.toUpperCase()} /api${path}`
    if (this.publicPaths.has(key)) throw new Error('公开路径重复注册')
    return owner.effect(() => {
      this.publicPaths.add(key)
      return () => {
        this.publicPaths.delete(key)
      }
    })
  }

  async registerProvider(
    owner: Context,
    id: string,
    implementation: string,
  ): Promise<ProviderHandle> {
    this.ctx.fiber.assertActive()
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('认证实例标识无效')
    if (this.providers.has(id)) throw new Error('认证实例重复注册')
    const token = { ready: false }
    let ready = false
    const assertReady = () => {
      owner.fiber.assertActive()
      this.ctx.fiber.assertActive()
      if (!ready || this.providers.get(id) !== token) throw new AuthError(401, '认证提供者不可用')
    }
    const release = owner.effect(() => {
      this.providers.set(id, token)
      return () => {
        ready = false
        token.ready = false
        if (this.providers.get(id) !== token) return
        // 先撤销运行登记，即使数据库离线，旧会话也无法通过验证。
        this.providers.delete(id)
      }
    })
    try {
      const db = this.db()
      const previous = await db
        .selectFrom('provider')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
      if (previous && previous.plugin_id !== implementation)
        throw new Error('认证实例已属于其他插件')
      if (!previous)
        await db
          .insertInto('provider')
          .values({ id, plugin_id: implementation, status: 'active' })
          .execute()
      if (previous?.status === 'disabled') throw new Error('认证实例已禁用')
      // 重载或进程重启后不能恢复此前签发的会话。
      await db
        .deleteFrom('session')
        .where(
          'identity_id',
          'in',
          db.selectFrom('identity').select('id').where('provider_id', '=', id),
        )
        .execute()
      owner.fiber.assertActive()
      ready = true
      token.ready = true
    } catch (error) {
      await release()
      throw error
    }
    return Object.freeze({
      provision: async (transaction: DatabaseTransaction, subject: string, displayName: string) => {
        assertReady()
        textField(subject, '身份标识')
        const db = this.db(transaction)
        const principalId = randomUUID()
        const identityId = randomUUID()
        await db
          .insertInto('principal')
          .values({
            id: principalId,
            kind: 'person',
            display_name: textField(displayName, '显示名称'),
            status: 'active',
            created_at: Date.now(),
          })
          .execute()
        await db
          .insertInto('identity')
          .values({
            id: identityId,
            principal_id: principalId,
            provider_id: id,
            subject,
            status: 'active',
          })
          .execute()
        assertReady()
        return { principalId, identityId }
      },
      issue: async (subject: string) => {
        assertReady()
        const db = this.db()
        const identity = await db
          .selectFrom('identity')
          .select(['id', 'principal_id'])
          .where('provider_id', '=', id)
          .where('subject', '=', subject)
          .executeTakeFirst()
        if (!identity) throw new AuthError(401, '账号不可用')
        const token = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + this.hours * 3_600_000
        await this.ctx.database.transaction(owner, async (transaction) => {
          const db = this.db(transaction)
          // 与禁用账号串行化，避免禁用期间签发的会话在重新启用后复活。
          await db
            .updateTable('principal')
            .set((eb) => ({ id: eb.ref('id') }))
            .where('id', '=', identity.principal_id)
            .execute()
          const active = await db
            .selectFrom('identity')
            .innerJoin('principal', 'principal.id', 'identity.principal_id')
            .innerJoin('provider', 'provider.id', 'identity.provider_id')
            .select('identity.id')
            .where('identity.id', '=', identity.id)
            .where('identity.status', '=', 'active')
            .where('principal.status', '=', 'active')
            .where('provider.status', '=', 'active')
            .executeTakeFirst()
          if (!active) throw new AuthError(401, '账号不可用')
          await db
            .insertInto('session')
            .values({
              id: randomUUID(),
              identity_id: identity.id,
              token_hash: hash(token),
              expires_at: expiresAt,
            })
            .execute()
          assertReady()
        })
        assertReady()
        return { token, expiresAt }
      },
    })
  }

  async authenticate(token: string | undefined): Promise<AuthContext | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const row = await this.db()
      .selectFrom('session')
      .innerJoin('identity', 'identity.id', 'session.identity_id')
      .innerJoin('principal', 'principal.id', 'identity.principal_id')
      .innerJoin('provider', 'provider.id', 'identity.provider_id')
      .select([
        'session.id as sessionId',
        'identity.id as identityId',
        'principal.id as principalId',
        'provider.id as providerId',
      ])
      .where('session.token_hash', '=', hash(token))
      .where('session.expires_at', '>', Date.now())
      .where('identity.status', '=', 'active')
      .where('principal.status', '=', 'active')
      .where('provider.status', '=', 'active')
      .executeTakeFirst()
    if (!row || !this.providers.get(row.providerId)?.ready) return
    return Object.freeze({ ...row, channel: 'web' as const })
  }

  auth(http: HttpContext): AuthContext {
    const auth = this.requests.get(http)
    if (!auth) throw new AuthError(401, '请先登录')
    return auth
  }

  token(http: HttpContext): string | undefined {
    const authorization = http.get('authorization')
    if (authorization)
      return authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined
    return http.cookies.get(cookieName, { signed: false })
  }

  setSession(http: HttpContext, session?: { token: string; expiresAt: number }): void {
    http.cookies.set(cookieName, session?.token ?? null, {
      signed: false,
      httpOnly: true,
      sameSite: 'strict',
      secure: http.secure,
      path: '/',
      overwrite: true,
      ...(session ? { expires: new Date(session.expiresAt) } : {}),
    })
  }

  async can(auth: AuthContext, permission: string, scope = 'system'): Promise<boolean> {
    if (!this.permissions.has(permission) || !this.providers.get(auth.providerId)?.ready)
      return false
    if (scope === 'system' && this.permissions.get(permission)!.defaultRoles.length) {
      try {
        const roles = await this.defaultRoles(auth)
        if (roles.some((role) => this.permissions.get(permission)?.defaultRoles.includes(role)))
          return true
      } catch (error) {
        if (error instanceof AuthError && error.status === 401) return false
        throw error
      }
    }
    const db = this.db()
    const row = await db
      .selectFrom('binding')
      .innerJoin('role', 'role.id', 'binding.role_id')
      .innerJoin('role_permission', 'role_permission.role_id', 'role.id')
      .innerJoin('principal', 'principal.id', 'binding.principal_id')
      .innerJoin('identity', 'identity.principal_id', 'principal.id')
      .innerJoin('provider', 'provider.id', 'identity.provider_id')
      .innerJoin('session', 'session.identity_id', 'identity.id')
      .select('role.id')
      .where('principal.id', '=', auth.principalId)
      .where('identity.id', '=', auth.identityId)
      .where('provider.id', '=', auth.providerId)
      .where('session.id', '=', auth.sessionId)
      .where('session.expires_at', '>', Date.now())
      .where('principal.status', '=', 'active')
      .where('identity.status', '=', 'active')
      .where('provider.status', '=', 'active')
      .where('role.status', '=', 'active')
      .where('role_permission.permission', '=', permission)
      .where('binding.scope_key', '=', hash(scope))
      .where((eb) =>
        eb.or([eb('binding.expires_at', 'is', null), eb('binding.expires_at', '>', Date.now())]),
      )
      .executeTakeFirst()
    return !!row
  }

  require(
    permission: string,
    resolveScope: (http: HttpContext) => string = () => 'system',
  ): Middleware {
    return async (http, next) => {
      if (!(await this.can(this.auth(http), permission, resolveScope(http))))
        throw new AuthError(403, '没有操作权限')
      await next()
    }
  }

  async principal(id: string): Promise<Principal | undefined> {
    return this.db().selectFrom('principal').selectAll().where('id', '=', id).executeTakeFirst()
  }

  /** 登录和账号资料响应附带的系统权限快照；真实 API 继续使用 require/can。 */
  async sessionSnapshot(auth: AuthContext): Promise<SessionSnapshot> {
    const session = await this.db()
      .selectFrom('session')
      .select('expires_at')
      .where('id', '=', auth.sessionId)
      .executeTakeFirst()
    if (!session || session.expires_at <= Date.now()) throw new AuthError(401, '请先登录')
    const permissions: string[] = []
    for (const permission of this.permissions.keys()) {
      if (await this.can(auth, permission)) permissions.push(permission)
    }
    return {
      actorId: auth.principalId,
      displayName: (await this.principal(auth.principalId))?.display_name ?? '用户',
      accountPath: this.loginPath('web', auth.providerId) ?? '/auth/user/',
      expiresAt: session.expires_at,
      permissions,
    }
  }

  /** 可信插件在已校验业务空间后调用；公开入口应使用 require 并校验授予者权限。 */
  async grantRole(
    transaction: DatabaseTransaction,
    input: {
      principalId: string
      roleId: string
      scope: string
      source: string
      expiresAt?: number
    },
  ): Promise<void> {
    const db = this.db(transaction)
    const scope = textField(input.scope, '授权范围')
    const source = textField(input.source, '授权来源')
    if (
      input.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
    )
      throw new AuthError(400, '授权有效期无效')
    if (
      !(await db
        .selectFrom('principal')
        .select('id')
        .where('id', '=', input.principalId)
        .executeTakeFirst()) ||
      !(await db.selectFrom('role').select('id').where('id', '=', input.roleId).executeTakeFirst())
    )
      throw new AuthError(404, '主体或角色不存在')
    await db
      .insertInto('binding')
      .values({
        principal_id: input.principalId,
        role_id: input.roleId,
        scope,
        scope_key: hash(scope),
        source,
        expires_at: input.expiresAt ?? null,
      })
      .execute()
  }

  async setPrincipalStatus(
    actor: AuthContext,
    principalId: string,
    status: unknown,
  ): Promise<void> {
    if (!(await this.can(actor, 'identity.local.manage'))) throw new AuthError(403, '没有操作权限')
    if (status !== 'active' && status !== 'disabled') throw new AuthError(400, '账号状态无效')
    if (principalId === actor.principalId) throw new AuthError(403, '不能修改自己的状态')
    const db = this.db()
    const privileged = await db
      .selectFrom('binding')
      .select('role_id')
      .where('principal_id', '=', principalId)
      .where('role_id', '=', 'administrator')
      .executeTakeFirst()
    if (privileged) throw new AuthError(403, '不能通过本地用户管理禁用系统管理员')
    await this.ctx.database.transaction(this.ctx, async (transaction) => {
      const db = this.db(transaction)
      await db.updateTable('principal').set({ status }).where('id', '=', principalId).execute()
      if (status === 'disabled')
        await db
          .deleteFrom('session')
          .where(
            'identity_id',
            'in',
            db.selectFrom('identity').select('id').where('principal_id', '=', principalId),
          )
          .execute()
    })
  }

  /** 仅供启动装配调用；认证插件不得将此能力暴露为公开接口。 */
  async bootstrap(transaction: DatabaseTransaction, principalId: string): Promise<void> {
    const db = this.db(transaction)
    if (
      !(await db
        .selectFrom('role')
        .select('id')
        .where('id', '=', 'administrator')
        .executeTakeFirst())
    ) {
      await db
        .insertInto('role')
        .values({ id: 'administrator', name: '系统管理员', status: 'active' })
        .execute()
      for (const permission of adminPermissions)
        await db
          .insertInto('role_permission')
          .values({ role_id: 'administrator', permission })
          .execute()
    }
    await this.grantRole(transaction, {
      principalId,
      roleId: 'administrator',
      scope: 'system',
      source: 'bootstrap',
    })
  }

  private routes(ctx: Context): void {
    ctx.server.route(ctx, 'GET', '/auth/me', async (http) => {
      const auth = this.auth(http)
      http.set('Cache-Control', 'no-store')
      http.body = {
        auth,
        principal: await this.principal(auth.principalId),
        session: await this.sessionSnapshot(auth),
      }
    })
    ctx.server.route(ctx, 'POST', '/auth/logout', async (http) => {
      await readJson(http)
      await this.db().deleteFrom('session').where('id', '=', this.auth(http).sessionId).execute()
      this.setSession(http)
      http.body = { ok: true }
    })
    ctx.server.route(ctx, 'GET', '/rbac/roles', this.require('authz.role.manage'), async (http) => {
      const db = this.db()
      http.body = {
        roles: await db.selectFrom('role').selectAll().execute(),
        grants: await db.selectFrom('role_permission').selectAll().execute(),
        permissions: [...this.permissions].map(([key, declaration]) => ({ key, ...declaration })),
      }
    })
    ctx.server.route(
      ctx,
      'PUT',
      '/rbac/roles/:id',
      this.require('authz.role.manage'),
      async (http) => {
        const body = await readJson(http)
        const id = textField(http.params.id, '角色标识')
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id))
          throw new AuthError(400, '角色标识必须使用小写字母、数字、下划线或连字符')
        if (id === 'administrator') throw new AuthError(403, '内置管理员角色不能修改')
        const name = textField(body.name, '角色名称')
        if (
          !Array.isArray(body.permissions) ||
          body.permissions.length > 100 ||
          body.permissions.some((p) => typeof p !== 'string' || !this.permissions.has(p))
        )
          throw new AuthError(400, '包含未声明的权限')
        const permissions = [...new Set(body.permissions as string[])]
        for (const permission of permissions)
          if (!(await this.can(this.auth(http), permission)))
            throw new AuthError(403, '不能授予自己没有的权限')
        await ctx.database.transaction(ctx, async (transaction) => {
          const db = this.db(transaction)
          const existing = await db
            .selectFrom('role')
            .select('id')
            .where('id', '=', id)
            .executeTakeFirst()
          if (existing) await db.updateTable('role').set({ name }).where('id', '=', id).execute()
          else await db.insertInto('role').values({ id, name, status: 'active' }).execute()
          await db.deleteFrom('role_permission').where('role_id', '=', id).execute()
          for (const permission of permissions)
            await db.insertInto('role_permission').values({ role_id: id, permission }).execute()
        })
        http.body = { ok: true }
      },
    )
    ctx.server.route(
      ctx,
      'GET',
      '/rbac/bindings/:id',
      this.require('authz.binding.manage'),
      async (http) => {
        http.body = await this.db()
          .selectFrom('binding')
          .selectAll()
          .where('principal_id', '=', textField(http.params.id, '主体标识'))
          .execute()
      },
    )
    ctx.server.route(
      ctx,
      'PUT',
      '/rbac/bindings/:id',
      this.require('authz.binding.manage'),
      async (http) => {
        const body = await readJson(http)
        const principalId = textField(http.params.id, '主体标识')
        const roleId = textField(body.roleId, '角色标识')
        const scope = textField(body.scope, '授权范围')
        if (typeof body.enabled !== 'boolean') throw new AuthError(400, 'enabled 必须是布尔值')
        const db = this.db()
        if (
          !(await this.principal(principalId)) ||
          !(await db.selectFrom('role').select('id').where('id', '=', roleId).executeTakeFirst())
        )
          throw new AuthError(404, '主体或角色不存在')
        const grants = await db
          .selectFrom('role_permission')
          .select('permission')
          .where('role_id', '=', roleId)
          .execute()
        for (const grant of grants)
          if (!(await this.can(this.auth(http), grant.permission, scope)))
            throw new AuthError(403, '不能管理超出自己权限的角色')
        await ctx.database.transaction(ctx, async (transaction) => {
          const db = this.db(transaction)
          await db
            .deleteFrom('binding')
            .where('principal_id', '=', principalId)
            .where('role_id', '=', roleId)
            .where('scope_key', '=', hash(scope))
            .where('source', '=', 'manual')
            .execute()
          if (body.enabled)
            await this.grantRole(transaction, { principalId, roleId, scope, source: 'manual' })
        })
        http.body = { ok: true }
      },
    )
  }
}

export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['server'],
  async apply(ctx: Context, config: Config = {}) {
    await ctx.plugin(RbacService, config)
  },
})
