import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { randomUUID } from 'node:crypto'
import { defineDatabasePlugin } from '@antarestra/database'
import type { Context } from '@antarestra/plugin-sdk'
import { AuthError, readJson, textField } from '@antarestra/rbac'
import { pluginId, migrations } from './schema.js'
import type { Tables } from './schema.js'
import {
  emailKey,
  generateInitialPassword,
  hashPassword,
  loginName,
  passwordInput,
  verifyPassword,
} from './password.js'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'
import type { HttpContext } from '@antarestra/plugin-server'

export interface Config {
  providerId?: string
  allowRegistration?: boolean
  bootstrapEmail?: string
  bootstrapPassword?: string
}

export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['rbac', 'server', 'webui'],
  async apply(ctx: Context, config: Config = {}) {
    config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), config)
    const providerId = config.providerId ?? 'local'
    const provider = await ctx.rbac.registerProvider(ctx, providerId, pluginId)
    const base = `/auth/local/${providerId}`
    const accountPath = providerId === 'local' ? '/auth/user/' : `/auth/user/${providerId}/`
    const changePasswordPath = accountPath + 'change-password/'
    const workspace = (actorId: string, displayName: string) => ({
      id: `personal:${actorId}`,
      label: `本地用户·${displayName}（${providerId}）`,
    })
    ctx.rbac.registerRequestSource(ctx, 'web', {
      id: providerId,
      loginPath: accountPath,
      async listWorkspaces(offset, limit) {
        return (await provider.principals(offset, limit)).map((principal) =>
          workspace(principal.id, principal.display_name),
        )
      },
      async resolveBackground(actorId, workspaceId) {
        if (workspaceId !== `personal:${actorId}`) return
        const roles = await ctx.rbac.backgroundRoles(providerId, actorId)
        if (roles) return { actorId, workspaceId, roles }
      },
      async resolve(request) {
        const http = request as HttpContext
        const auth = await ctx.rbac.authenticate(ctx.rbac.token(http))
        if (!auth || auth.providerId !== providerId) return
        const space = workspace(
          auth.principalId,
          (await ctx.rbac.principal(auth.principalId))?.display_name ?? '用户',
        )
        return {
          actorId: auth.principalId,
          workspaceId: space.id,
          workspaceLabel: space.label,
          roles: await ctx.rbac.defaultRoles(auth),
          auth,
        }
      },
    })
    const db = ctx.database.scope<Tables>(ctx, pluginId)
    const lookup = (normalized: string) =>
      db
        .selectFrom('account')
        .selectAll()
        .where('instance_id', '=', providerId)
        .where('email_key', '=', emailKey(normalized))
        .executeTakeFirst()
    const create = async (
      normalized: string,
      password: string,
      name: string,
      administrator = false,
      passwordChangeRequired = false,
      initialRole = 'user',
    ) => {
      const passwordHash = await hashPassword(password)
      const id = randomUUID()
      return ctx.database.transaction(ctx, async (transaction) => {
        const scoped = transaction.scope<Tables>(ctx, pluginId)
        const identity = await provider.provision(transaction, id, name)
        await scoped
          .insertInto('account')
          .values({
            id,
            instance_id: providerId,
            email: normalized,
            email_key: emailKey(normalized),
            password_hash: passwordHash,
            password_change_required: passwordChangeRequired ? 1 : 0,
            identity_id: identity.identityId,
            principal_id: identity.principalId,
            created_at: Date.now(),
          })
          .execute()
        if (administrator) await ctx.rbac.bootstrap(transaction, identity.principalId)
        else if (initialRole !== 'user')
          await ctx.rbac.grantRole(transaction, {
            principalId: identity.principalId,
            roleId: initialRole,
            scope: 'system',
            source: 'manual',
          })
        return id
      })
    }

    if (config.bootstrapEmail !== undefined || config.bootstrapPassword !== undefined) {
      const normalized = loginName(config.bootstrapEmail)
      const password = passwordInput(config.bootstrapPassword)
      // 只创建新账号，绝不按同名邮箱提升公开注册账号，也不覆盖既有密码。
      if (!(await lookup(normalized))) {
        await create(normalized, password, '系统管理员', true)
      }
    }

    const dummyHash = await hashPassword(randomUUID())
    const attempts = new Map<string, { count: number; until: number }>()
    let hashing = 0
    ctx.effect(() => () => {
      attempts.clear()
    })
    const accountForPrincipal = (principalId: string) =>
      db
        .selectFrom('account')
        .selectAll()
        .where('instance_id', '=', providerId)
        .where('principal_id', '=', principalId)
        .executeTakeFirst()
    ctx.server.use(ctx, async (http, next) => {
      if (!http.path.startsWith('/api/')) return next()
      const auth = await ctx.rbac.authenticate(ctx.rbac.token(http))
      if (!auth || auth.providerId !== providerId) return next()
      const account = await accountForPrincipal(auth.principalId)
      if (
        !account?.password_change_required ||
        [`${base}/account`, `${base}/password`, '/auth/me', '/auth/logout'].some(
          (path) => http.path === `/api${path}`,
        )
      )
        return next()
      throw new AuthError(403, '请先修改初始密码')
    })
    const limit = (ip: string) => {
      const now = Date.now()
      for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key)
      let item = attempts.get(ip)
      if (!item) {
        if (attempts.size >= 4096) throw new AuthError(429, '请求过于频繁，请稍后再试')
        attempts.set(ip, (item = { count: 0, until: now + 60_000 }))
      }
      if (++item.count > 20 || hashing >= 2) throw new AuthError(429, '请求过于频繁，请稍后再试')
    }
    ctx.rbac.registerReauthentication(ctx, providerId, async (auth, password, ip) => {
      limit(ip)
      hashing++
      try {
        const account = await accountForPrincipal(auth.principalId)
        return (
          !!account &&
          account.identity_id === auth.identityId &&
          (await verifyPassword(passwordInput(password), account.password_hash))
        )
      } finally {
        hashing--
      }
    })
    for (const operation of ['login', 'register']) {
      const path = `${base}/${operation}`
      ctx.rbac.publicRoute(ctx, 'POST', path)
      ctx.server.route(ctx, 'POST', path, async (http) => {
        limit(http.ip)
        const body = await readJson(http)
        const normalized = loginName(body.loginName ?? body.email)
        const password = passwordInput(body.password)
        if (hashing >= 2) throw new AuthError(429, '请求过于频繁，请稍后再试')
        hashing++
        try {
          if (operation === 'register') {
            if (!config.allowRegistration) throw new AuthError(403, '本站未开放注册')
            if (await lookup(normalized)) throw new AuthError(409, '账号无法注册')
            const name = textField(body.displayName, '显示名称')
            try {
              await create(normalized, password, name)
            } catch (error) {
              if (await lookup(normalized)) throw new AuthError(409, '账号无法注册')
              throw error
            }
            http.status = 201
            http.body = { ok: true }
          } else {
            const account = await lookup(normalized)
            const valid = await verifyPassword(password, account?.password_hash ?? dummyHash)
            if (!account || !valid) throw new AuthError(401, '登录名或密码错误')
            const session = await provider.issue(account.id)
            const auth = await ctx.rbac.authenticate(session.token)
            if (!auth) throw new AuthError(401, '账号不可用')
            const snapshot = {
              ...(await ctx.rbac.sessionSnapshot(auth)),
              ...(account.password_change_required === 1 ? { passwordChangeRequired: true } : {}),
            }
            ctx.rbac.setSession(http, session)
            http.set('Cache-Control', 'no-store')
            http.body = { ok: true, expiresAt: session.expiresAt, session: snapshot }
          }
        } finally {
          hashing--
        }
      })
    }
    ctx.server.route(ctx, 'GET', `${base}/account`, async (http) => {
      const auth = ctx.rbac.auth(http)
      const account = await accountForPrincipal(auth.principalId)
      if (!account) throw new AuthError(404, '本地账号不存在')
      http.body = {
        loginName: account.email,
        passwordChangeRequired: account.password_change_required === 1,
        changePasswordPath,
      }
    })
    ctx.server.route(ctx, 'POST', `${base}/password`, async (http) => {
      const auth = ctx.rbac.auth(http)
      const body = await readJson(http)
      const currentPassword = passwordInput(body.currentPassword)
      const nextPassword = passwordInput(body.newPassword)
      const account = await accountForPrincipal(auth.principalId)
      if (!account || !(await verifyPassword(currentPassword, account.password_hash)))
        throw new AuthError(400, '原密码错误')
      if (currentPassword === nextPassword) throw new AuthError(400, '新密码不能与原密码相同')
      const passwordHash = await hashPassword(nextPassword)
      await ctx.database.transaction(ctx, async (transaction) => {
        const scoped = transaction.scope<Tables>(ctx, pluginId)
        await scoped
          .updateTable('account')
          .set({ password_hash: passwordHash, password_change_required: 0 })
          .where('id', '=', account.id)
          .execute()
        await ctx.rbac.revokeSessions(transaction, account.principal_id, auth.sessionId)
      })
      const snapshot = {
        ...(await ctx.rbac.sessionSnapshot(auth)),
        passwordChangeRequired: false,
      }
      http.body = { ok: true, session: snapshot }
    })
    ctx.server.route(
      ctx,
      'POST',
      `${base}/users`,
      ctx.rbac.require('identity.local.manage'),
      ctx.rbac.require('authz.binding.manage'),
      async (http) => {
        const body = await readJson(http)
        const normalized = loginName(body.loginName)
        const displayName = textField(body.displayName, '用户名')
        const roleId = textField(body.roleId, '初始角色', 64)
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(roleId)) throw new AuthError(400, '初始角色无效')
        if ((await ctx.rbac.role(roleId))?.status !== 'active')
          throw new AuthError(400, '请选择可用的初始角色')
        if (await lookup(normalized)) throw new AuthError(409, '登录名已存在')
        const password = generateInitialPassword()
        try {
          await create(normalized, password, displayName, false, true, roleId)
        } catch (error) {
          if (await lookup(normalized)) throw new AuthError(409, '登录名已存在')
          throw error
        }
        http.status = 201
        http.body = {
          loginName: normalized,
          displayName,
          initialPassword: password,
          loginUrl: ctx.server.url(accountPath),
        }
      },
    )
    ctx.server.route(
      ctx,
      'POST',
      `${base}/users/:id/reset-password`,
      ctx.rbac.require('identity.local.manage'),
      async (http) => {
        const id = textField(http.params.id, '账号标识')
        const account = await db
          .selectFrom('account')
          .selectAll()
          .where('instance_id', '=', providerId)
          .where('id', '=', id)
          .executeTakeFirst()
        if (!account) throw new AuthError(404, '账号不存在')
        const principal = await ctx.rbac.principal(account.principal_id)
        if (!principal) throw new AuthError(404, '用户不存在')
        const password = generateInitialPassword()
        const passwordHash = await hashPassword(password)
        await ctx.database.transaction(ctx, async (transaction) => {
          await transaction
            .scope<Tables>(ctx, pluginId)
            .updateTable('account')
            .set({ password_hash: passwordHash, password_change_required: 1 })
            .where('id', '=', account.id)
            .execute()
          await ctx.rbac.revokeSessions(transaction, account.principal_id)
        })
        http.body = {
          loginName: account.email,
          displayName: principal.display_name,
          initialPassword: password,
          loginUrl: ctx.server.url(accountPath),
        }
      },
    )
    ctx.server.route(
      ctx,
      'GET',
      `${base}/users`,
      ctx.rbac.require('identity.local.manage'),
      async (http) => {
        const offset = Number(http.query.offset ?? 0)
        if (!Number.isSafeInteger(offset) || offset < 0) throw new AuthError(400, '分页参数无效')
        const search = String(http.query.q ?? '')
          .trim()
          .toLocaleLowerCase()
        const status = String(http.query.status ?? '')
        const role = String(http.query.role ?? '').trim()
        if (search.length > 128 || role.length > 64 || !['', 'active', 'disabled'].includes(status))
          throw new AuthError(400, '筛选条件无效')
        const principals = new Map(
          (await ctx.rbac.userDirectory(status)).map((entry) => [entry.principal.id, entry]),
        )
        // 通过定义服务组合跨插件数据，筛选发生在分页之前。
        const accounts = await db
          .selectFrom('account')
          .select(['id', 'email', 'principal_id', 'created_at'])
          .where('instance_id', '=', providerId)
          .orderBy('created_at')
          .orderBy('id')
          .execute()
        const matching = []
        for (const account of accounts) {
          const entry = principals.get(account.principal_id)
          const principal = entry?.principal
          if (
            !principal ||
            (search &&
              ![account.email, principal.display_name, principal.id].some((value) =>
                value.toLocaleLowerCase().includes(search),
              ))
          )
            continue
          const roles = entry!.roles
          if (role && !roles.some((item) => item.id === role)) continue
          matching.push({ ...account, principal, roles })
        }
        http.body = { users: matching.slice(offset, offset + 50), total: matching.length }
      },
    )
    ctx.server.route(
      ctx,
      'PUT',
      `${base}/users/:id/status`,
      ctx.rbac.require('identity.local.manage'),
      async (http) => {
        const body = await readJson(http)
        const account = await db
          .selectFrom('account')
          .select('principal_id')
          .where('instance_id', '=', providerId)
          .where('id', '=', textField(http.params.id, '账号标识'))
          .executeTakeFirst()
        if (!account) throw new AuthError(404, '账号不存在')
        await ctx.rbac.setPrincipalStatus(ctx.rbac.auth(http), account.principal_id, body.status)
        http.body = { ok: true }
      },
    )
    ctx.webui.addEntry(ctx, {
      id: 'auth-local-' + providerId,
      directory: fileURLToPath(new URL('../public/', import.meta.url)),
      config: {
        base,
        allowRegistration: !!config.allowRegistration,
        path: accountPath,
        changePasswordPath,
        title: providerId === 'local' ? '账号中心' : '账号中心 · ' + providerId,
      },
    })
  },
})
