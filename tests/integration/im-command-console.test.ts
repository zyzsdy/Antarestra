import { afterEach, expect, it } from 'vitest'
import commands from '@antarestra/plugin-im-commands'
import { cleanup } from './im-features-fixture.js'
import { setupStickers } from './im-stickers-fixture.js'

afterEach(cleanup)
const policy = {
  access: 'bot-admin',
  group: { mode: 'whitelist', ids: ['g1'] },
  private: { mode: 'blacklist', ids: [] },
}
it('命令权限 API 校验管理权限、同源、完整规则和修订冲突，保存立即影响指令', async () => {
  const app = await setupStickers()
  const { request, cookie, ctx } = app
  expect((await request('/im/commands')).status).toBe(401)
  await request('/auth/local/local/register', '', {
    email: 'reader@example.com',
    password: 'reader-password',
    displayName: '普通用户',
  })
  const login = await request('/auth/local/local/login', '', {
    email: 'reader@example.com',
    password: 'reader-password',
  })
  const user = login.headers.get('set-cookie')!.split(';')[0]!
  expect((await request('/im/commands', user)).status).toBe(403)
  expect((await request('/im/commands/ping', user)).status).toBe(403)
  expect((await request('/im/commands/ping', user, { policy, revision: 0 }, 'PUT')).status).toBe(
    403,
  )
  const current = await (await request('/im/commands/ping', cookie)).json()
  expect(
    (
      await request(
        '/im/commands/ping',
        cookie,
        { policy, revision: current.revision },
        'PUT',
        'https://other.invalid',
      )
    ).status,
  ).toBe(403)
  for (const invalid of [
    { ...policy, access: 'admin' },
    { access: 'user' },
    { ...policy, group: { mode: 'whitelist', ids: ['a b'] } },
    { ...policy, private: { mode: 'blacklist', ids: ['a', 'a'] } },
    { ...policy, group: { mode: 'whitelist', ids: [123] } },
  ])
    expect(
      (
        await request(
          '/im/commands/ping',
          cookie,
          { policy: invalid, revision: current.revision },
          'PUT',
        )
      ).status,
    ).toBe(400)
  expect((await request('/im/commands/ping', cookie, { policy, revision: -1 }, 'PUT')).status).toBe(
    400,
  )
  const saved = await request(
    '/im/commands/ping',
    cookie,
    { policy, revision: current.revision },
    'PUT',
  )
  expect(saved.status).toBe(200)
  expect(saved.headers.get('cache-control')).toBe('no-store')
  expect(await saved.json()).toEqual({ policy, revision: current.revision + 1 })
  expect(
    (await request('/im/commands/ping', cookie, { policy, revision: current.revision }, 'PUT'))
      .status,
  ).toBe(409)
  const before = app.sent.length
  await app.receive('/ping', 'owner', 'g2')
  expect(app.sent).toHaveLength(before)
  await app.receive('/ping', 'owner', 'g1')
  expect(app.sent.at(-1)).toEqual([{ type: 'text', text: 'pong' }])
  expect((await ctx.imCommands.getPolicy('ping')).policy).toEqual(policy)
})

it('目录自动列出其他插件指令，支持搜索分页、插件卸载重载，首次并发保存拒绝覆盖', async () => {
  const app = await setupStickers(true)
  const { ctx, request, cookie } = app
  const first = await (await request('/im/commands', cookie)).json()
  expect(first.commands.map((item: { name: string }) => item.name)).toEqual(
    expect.arrayContaining(['ai', 'stop', 'reset', 'sticker']),
  )
  expect(
    first.commands.find((item: { name: string }) => item.name === 'sticker').policy.access,
  ).toBe('bot-admin')
  const disposers = Array.from({ length: 25 }, (_, i) =>
    ctx.imCommands.register(ctx, {
      name: `sample-${String(i).padStart(2, '0')}`,
      description: '分页测试',
      execute: () => '',
    }),
  )
  const page = await (await request('/im/commands?search=sample&offset=20', cookie)).json()
  expect(page).toMatchObject({ total: 25, offset: 20 })
  expect(page.commands).toHaveLength(5)
  expect(page.commands[0]).toMatchObject({
    name: 'sample-20',
    revision: 0,
    policy: { group: { mode: 'whitelist', ids: [] }, private: { mode: 'whitelist', ids: [] } },
  })
  expect((await request('/im/commands?offset=-1', cookie)).status).toBe(400)
  const race = await Promise.all(
    [0, 1].map(() => request('/im/commands/sample-00', cookie, { policy, revision: 0 }, 'PUT')),
  )
  expect(race.map((item) => item.status).sort()).toEqual([200, 409])
  await disposers[0]!()
  expect((await request('/im/commands/sample-00', cookie)).status).toBe(404)
  expect(
    (await request('/im/commands/sample-00', cookie, { policy, revision: 1 }, 'PUT')).status,
  ).toBe(404)
  await app.commandPlugin.dispose()
  expect((await request('/im/commands', cookie)).status).toBe(503)
  await ctx.plugin(commands)
  const reloaded = await (await request('/im/commands', cookie)).json()
  expect(reloaded.commands.map((item: { name: string }) => item.name)).toContain('sticker')
})
