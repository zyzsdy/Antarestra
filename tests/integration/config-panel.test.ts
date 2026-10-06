import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import * as loader from '@antarestra/config-loader'
import { resolvePlugin } from '../../apps/server/src/plugins.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 10 })
})
const password = 'panel-test-password-42'
async function setup(local = false) {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-panel-api-'))
  directories.push(directory)
  const filename = join(directory, 'main.yml')
  await writeFile(
    filename,
    `plugins:
  database: {}
  plugin-database-kysely: { filename: ':memory:' }
  plugin-server: { host: '127.0.0.1', port: 0 }
  webui: {}
  rbac: {}
  plugin-auth-local:
    providerId: local
    allowRegistration: true
    bootstrapEmail: admin@example.com
    bootstrapPassword: ${password}
  plugin-admin-console: {}
  plugin-config-panel: {}
`,
  )
  if (local) await writeFile(join(directory, 'main.local.yml'), '{}\n')
  const ctx = new Context()
  contexts.push(ctx)
  const restart = vi.fn(async () => {})
  await ctx.plugin(loader, { filename, resolvePlugin, restart })
  await vi.waitFor(
    async () =>
      expect(
        (await ctx.configManager.snapshot()).instances.every((item) => item.status === 'active'),
      ).toBe(true),
    { timeout: 5000 },
  )
  const url = `http://127.0.0.1:${ctx.server.address!.port}`
  const request = (path: string, cookie = '', body?: object, method = 'POST') =>
    fetch(url + '/api' + path, {
      method: body ? method : 'GET',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const login = async (email = 'admin@example.com') => {
    const response = await request('/auth/local/local/login', '', { email, password })
    expect(response.status).toBe(200)
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  return { ctx, request, login, restart, filename }
}
it.each([false, true])(
  '删除未设置面板元数据的配置成功，任务结果直接返回新快照（local=%s）',
  async (local) => {
    const app = await setup(local)
    const original = await readFile(app.filename, 'utf8')
    const cookie = await app.login()
    await app.ctx.configManager.add(
      (await app.ctx.configManager.snapshot()).version,
      '@antarestra/plugin-logger',
      { id: 'fixture', state: 'running', saved: false, message: '' },
    )
    const before = await app.ctx.configManager.snapshot()
    if (local) {
      expect(await readFile(app.filename, 'utf8')).toBe(original)
      expect(await readFile(app.filename.replace(/\.yml$/, '.local.yml'), 'utf8')).toContain(
        'logger',
      )
    }
    const id = before.instances.find((item) => item.pluginId === 'logger')!.instanceId
    const response = await app.request(
      '/plugin-config-panel/instances/' + encodeURIComponent(id),
      cookie,
      { version: before.version },
      'DELETE',
    )
    expect(response.status).toBe(202)
    const operation = (await response.json()) as { id: string }
    await vi.waitFor(async () => {
      const result = await app.request('/plugin-config-panel/operations/' + operation.id, cookie)
      const completed = (await result.json()) as {
        state: string
        snapshot: { version: string; instances: { instanceId: string }[] }
      }
      expect(completed.state).toBe('completed')
      expect(completed.snapshot.version).not.toBe(before.version)
      expect(completed.snapshot.instances.some((item) => item.instanceId === id)).toBe(false)
    })
    if (local) expect(await readFile(app.filename, 'utf8')).toBe(original)
  },
)
it('管理 API：认证、默认权限、保存任务、配置版本和敏感值边界', async () => {
  const app = await setup()
  expect((await app.request('/plugin-config-panel')).status).toBe(401)
  app.ctx.server.route(app.ctx, 'GET', '/public-probe', (http) => {
    http.body = 'public'
  })
  const release = app.ctx.rbac.publicRoute(app.ctx, 'GET', '/public-probe')
  expect((await app.request('/public-probe')).status).toBe(200)
  await release()
  expect((await app.request('/public-probe')).status).toBe(401)
  const cookie = await app.login()
  const profile = (await (await app.request('/auth/me', cookie)).json()) as {
    session: { permissions: string[] }
  }
  expect(profile.session.permissions).toContain('admin.plugins.manage')
  expect(profile.session.permissions).toContain('admin.system.restart')
  const response = await app.request('/plugin-config-panel', cookie)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const state = (await response.json()) as { version: string }
  const result = await app.request(
    '/plugin-config-panel/instances/plugin-admin-console',
    cookie,
    { version: state.version, yaml: '{}', alias: '我的后台', enabled: true },
    'PUT',
  )
  expect(result.status).toBe(202)
  const op = (await result.json()) as { id: string }
  await vi.waitFor(async () =>
    expect(
      (
        (await (await app.request('/plugin-config-panel/operations/' + op.id, cookie)).json()) as {
          state: string
        }
      ).state,
    ).toBe('completed'),
  )
  expect(
    (await app.ctx.configManager.snapshot()).layout.instances['plugin-admin-console']?.alias,
  ).toBe('我的后台')
  const raw = await (
    await app.request('/plugin-config-panel/instances/plugin-auth-local', cookie)
  ).text()
  expect(raw).toContain(password)
  const register = await app.request('/auth/local/local/register', '', {
    email: 'user@example.com',
    password,
    displayName: '测试用户',
  })
  expect(register.status).toBe(201)
  const member = await app.login('user@example.com')
  expect((await app.request('/plugin-config-panel', member)).status).toBe(403)
  expect((await app.request('/plugin-config-panel/restart', member, { password })).status).toBe(403)
  expect(
    (
      await app.request(
        '/rbac/roles/user',
        cookie,
        {
          name: '仅重启操作员',
          permissions: ['admin.console.view', 'admin.system.restart'],
        },
        'PUT',
      )
    ).status,
  ).toBe(200)
  expect((await app.request('/plugin-config-panel/restart', member)).status).toBe(200)
  expect((await app.request('/plugin-config-panel', member)).status).toBe(403)
  expect(
    (await app.request('/plugin-config-panel/instances/plugin-auth-local', member)).status,
  ).toBe(403)
  expect((await app.request('/plugin-config-panel/restart', member, { password })).status).toBe(202)
  await vi.waitFor(() => expect(app.restart).toHaveBeenCalledOnce())
}, 10000)
it('重启要求当前密码，重复重启被拒绝，认证停止后保留默认拒绝', async () => {
  const app = await setup()
  const cookie = await app.login()
  expect(
    (await app.request('/plugin-config-panel/restart', cookie, { password: 'wrong-password' }))
      .status,
  ).toBe(403)
  expect(app.restart).not.toHaveBeenCalled()
  expect((await app.request('/plugin-config-panel/restart', cookie, { password })).status).toBe(202)
  await vi.waitFor(() => expect(app.restart).toHaveBeenCalledOnce())
  expect((await app.request('/plugin-config-panel/restart', cookie, { password })).status).toBe(409)
  await app.ctx.configManager.instances.get('rbac')!.fiber!.dispose()
  expect((await app.request('/auth/me', cookie)).status).toBe(503)
  expect((await app.request('/health')).status).toBe(200)
}, 10000)
it('面板自身重新应用后任务保留，API 恢复且没有重复实例', async () => {
  const app = await setup()
  const cookie = await app.login()
  const before = app.ctx.configManager.instances.get('plugin-config-panel')!.fiber
  const response = await app.request(
    '/plugin-config-panel/instances/plugin-config-panel/apply',
    cookie,
    {
      version: (await app.ctx.configManager.snapshot()).version,
    },
  )
  expect(response.status).toBe(202)
  const operation = (await response.json()) as { id: string }
  await vi.waitFor(
    async () => {
      const result = await app.request('/plugin-config-panel/operations/' + operation.id, cookie)
      expect(result.status).toBe(200)
      expect(((await result.json()) as { state: string }).state).toBe('completed')
    },
    { timeout: 5000 },
  )
  expect(app.ctx.configManager.instances.get('plugin-config-panel')!.fiber).not.toBe(before)
  expect((await app.request('/plugin-config-panel', cookie)).status).toBe(200)
}, 10000)
it('显式公共接口不依赖认证器，旧认证器卸载不会公开受保护接口', async () => {
  const { default: Server } = await import('@antarestra/plugin-server')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${ctx.server.address!.port}`
  ctx.server.route(ctx, 'GET', '/private', (http) => {
    http.body = '私有'
  })
  ctx.server.route(ctx, 'GET', '/public', (http) => {
    http.body = '公开'
  })
  const release = ctx.server.publicRoute(ctx, 'GET', '/public')
  expect((await fetch(url + '/api/private')).status).toBe(503)
  expect(await (await fetch(url + '/api/public')).text()).toBe('公开')
  await release()
  expect((await fetch(url + '/api/public')).status).toBe(503)
})
