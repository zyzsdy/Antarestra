import { randomUUID } from 'node:crypto'
import { defineDatabasePlugin } from '@antarestra/database'
import type { Context } from '@antarestra/plugin-sdk'
import { AuthError, readJson, textField } from '@antarestra/rbac'
import { pluginId, migrations } from './schema.js'
import type { Tables } from './schema.js'
import { email, emailKey, passwordInput, hashPassword, verifyPassword } from './password.js'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

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
    if (
      !config ||
      typeof config !== 'object' ||
      Object.keys(config).some(
        (key) =>
          !['providerId', 'allowRegistration', 'bootstrapEmail', 'bootstrapPassword'].includes(key),
      )
    )
      throw new Error('本地认证配置无效')
    if (config.allowRegistration !== undefined && typeof config.allowRegistration !== 'boolean')
      throw new Error('allowRegistration 必须是布尔值')
    const providerId = config.providerId ?? 'local'
    const provider = await ctx.rbac.registerProvider(ctx, providerId, pluginId)
    const base = `/auth/local/${providerId}`
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
            identity_id: identity.identityId,
            principal_id: identity.principalId,
            created_at: Date.now(),
          })
          .execute()
        if (administrator) await ctx.rbac.bootstrap(transaction, identity.principalId)
        return id
      })
    }

    if (config.bootstrapEmail !== undefined || config.bootstrapPassword !== undefined) {
      const normalized = email(config.bootstrapEmail)
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
    for (const operation of ['login', 'register']) {
      const path = `${base}/${operation}`
      ctx.rbac.publicRoute(ctx, 'POST', path)
      ctx.server.route(ctx, 'POST', path, async (http) => {
        limit(http.ip)
        const body = await readJson(http)
        const normalized = email(body.email)
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
            if (!account || !valid) throw new AuthError(401, '邮箱或密码错误')
            const session = await provider.issue(account.id)
            ctx.rbac.setSession(http, session)
            http.body = { ok: true, expiresAt: session.expiresAt }
          }
        } finally {
          hashing--
        }
      })
    }
    ctx.server.route(
      ctx,
      'GET',
      `${base}/users`,
      ctx.rbac.require('identity.local.manage'),
      async (http) => {
        const offset = Number(http.query.offset ?? 0)
        if (!Number.isSafeInteger(offset) || offset < 0) throw new AuthError(400, '分页参数无效')
        const accounts = await db
          .selectFrom('account')
          .select(['id', 'email', 'principal_id', 'created_at'])
          .where('instance_id', '=', providerId)
          .orderBy('created_at')
          .orderBy('id')
          .limit(50)
          .offset(offset)
          .execute()
        http.body = await Promise.all(
          accounts.map(async (account) => ({
            ...account,
            principal: await ctx.rbac.principal(account.principal_id),
          })),
        )
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
        path: providerId === 'local' ? '/auth/user/' : '/auth/user/' + providerId + '/',
        title: providerId === 'local' ? '账号中心' : '账号中心 · ' + providerId,
      },
    })
  },
})
