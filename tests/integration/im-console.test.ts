import { afterEach, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import Database from '@antarestra/database'
import * as sqlite from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import WebUI from '@antarestra/webui'
import local from '@antarestra/plugin-auth-local'
import im from '@antarestra/im'
import * as consolePlugin from '@antarestra/plugin-im-console'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
it('IM 管理接口校验登录、角色、同源和修订号，卸载后撤销路由', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Database)
  await ctx.plugin(sqlite, { filename: ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  await ctx.plugin(WebUI)
  ctx.rbac.registerPermission(ctx, 'admin.console.view', '控制台', ['admin'])
  await ctx.plugin(local, {
    providerId: 'local',
    allowRegistration: true,
    bootstrapEmail: 'admin@example.com',
    bootstrapPassword: 'im-console-test-42',
  })
  await ctx.plugin(im)
  const fiber = await ctx.plugin(consolePlugin)
  ctx.im.registerConnection(ctx, {
    id: 'test',
    platform: 'qq',
    accountId: '05',
    policy: { group: { mode: 'whitelist', ids: ['40894918'] } },
    send: async () => ({}),
  })
  const base = `http://127.0.0.1:${ctx.server.address!.port}/api`
  const request = (path: string, cookie = '', body?: object, method = 'POST', origin?: string) =>
    fetch(base + path, {
      method: body ? method : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  expect((await request('/im/connections')).status).toBe(401)
  await request('/auth/local/local/register', '', {
    email: 'user@example.com',
    password: 'im-console-test-42',
    displayName: '普通用户',
  })
  const userLogin = await request('/auth/local/local/login', '', {
    email: 'user@example.com',
    password: 'im-console-test-42',
  })
  const userCookie = userLogin.headers.get('set-cookie')!.split(';')[0]!
  expect((await request('/im/connections', userCookie)).status).toBe(403)
  const login = await request('/auth/local/local/login', '', {
    email: 'admin@example.com',
    password: 'im-console-test-42',
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const listing = await request('/im/connections', cookie)
  expect(listing.status).toBe(200)
  expect(await listing.json()).toMatchObject({ connections: [{ id: 'test', accountId: '05' }] })
  const policy = {
    group: { mode: 'whitelist', ids: ['40894918'] },
    defaults: {
      ai: true,
      appendReplyFormat: true,
      activation: { dynamic: { baseProbability: 0.003, maxSilentMessages: 150 } },
    },
  }
  expect(
    (
      await request(
        '/im/connections/test/policy',
        cookie,
        { policy, revision: 0 },
        'PUT',
        'https://untrusted.example',
      )
    ).status,
  ).toBe(403)
  const saved = await request('/im/connections/test/policy', cookie, { policy, revision: 0 }, 'PUT')
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ revision: 1, policy })
  expect(await (await request('/im/connections/test/policy', cookie)).json()).toMatchObject({
    revision: 1,
    policy,
  })
  expect(
    (
      await request(
        '/im/connections/test/policy',
        cookie,
        {
          policy: { defaults: { activation: { dynamic: { maxSilentMessages: 0 } } } },
          revision: 1,
        },
        'PUT',
      )
    ).status,
  ).toBe(400)
  expect(
    (await request('/im/connections/test/policy', cookie, { policy, revision: 0 }, 'PUT')).status,
  ).toBe(409)
  expect(
    (
      await request(
        '/im/connections/test/policy',
        cookie,
        { policy: { group: { mode: 'oops', ids: [] } }, revision: 1 },
        'PUT',
      )
    ).status,
  ).toBe(400)
  expect(ctx.im.getChatPolicy('test', { type: 'group', id: '40894918' }).ai).toBe(true)
  expect(ctx.im.getChatPolicy('test', { type: 'group', id: 'other' }).enabled).toBe(false)
  await fiber.dispose()
  expect((await request('/im/connections', cookie)).status).toBe(404)
})
