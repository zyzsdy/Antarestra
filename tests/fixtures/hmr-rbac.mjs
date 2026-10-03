import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Logger } from '@antarestra/plugin-sdk'
import * as configLoader from '@antarestra/config-loader'

const directory = await mkdtemp(join(tmpdir(), 'antarestra rbac hmr '))
const ctx = new Context()
const errors = []
ctx.logger.exporter({
  export(message) {
    const content = Logger.format({ export() {} }, message)
    if (message.type === 'error') errors.push(content)
    console.log(`[${message.type}] ${content}`)
  },
})

async function waitFor(predicate) {
  const until = Date.now() + 6000
  while (!predicate()) {
    assert.deepEqual(errors, [])
    if (Date.now() > until) throw new Error('等待 RBAC 热重载超时')
    await delay(40)
  }
}

try {
  const source = fileURLToPath(new URL('../../plugins/definitions/rbac/', import.meta.url))
  const copy = join(directory, 'rbac')
  await cp(join(source, 'src'), join(copy, 'src'), { recursive: true })
  for (const name of ['package.json', 'config.schema.json']) {
    await cp(join(source, name), join(copy, name))
  }
  await symlink(
    join(source, 'node_modules'),
    join(copy, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const entry = join(copy, 'src', 'index.ts')
  const original = await readFile(entry, 'utf8')
  const urls = {
    hmr: import.meta.resolve('@antarestra/plugin-hmr'),
    database: import.meta.resolve('@antarestra/database'),
    'database-kysely': import.meta.resolve('@antarestra/plugin-database-kysely'),
    server: import.meta.resolve('@antarestra/plugin-server'),
    webui: import.meta.resolve('@antarestra/webui'),
    rbac: pathToFileURL(entry).href,
    'auth-local': import.meta.resolve('@antarestra/plugin-auth-local'),
  }
  const resolver = configLoader.createPluginResolver((id) => {
    const url = urls[id.replace('@antarestra/', '')]
    if (!url) throw Object.assign(new Error('不存在'), { code: 'ERR_MODULE_NOT_FOUND' })
    return url
  })
  const filename = join(directory, 'main.yml')
  await writeFile(
    filename,
    JSON.stringify({
      plugins: {
        hmr: { include: ['rbac'] },
        database: {},
        'database-kysely': { filename: ':memory:' },
        server: { host: '127.0.0.1', port: 0 },
        webui: {},
        rbac: {},
        'auth-local': {
          providerId: 'hmr-test',
          bootstrapEmail: 'admin@example.com',
          bootstrapPassword: 'test-only-password-42',
        },
      },
    }),
  )
  await ctx.plugin(configLoader, {
    filename,
    resolvePlugin: resolver,
    baseUrl: pathToFileURL(directory + sep).href,
  })
  for (const item of ctx.configManager.instances.values()) {
    assert.ok(item.fiber, item.error)
    await item.fiber.await()
  }
  const port = ctx.server.address.port
  const serverFiber = ctx.configManager.instances.get('server').fiber
  const pid = process.pid
  const request = (path, options) => fetch(`http://127.0.0.1:${port}/api${path}`, options)
  async function checkAuthentication() {
    assert.equal((await request('/health')).status, 200)
    assert.equal((await request('/auth/me')).status, 401)
    const response = await request('/auth/local/hmr-test/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'test-only-password-42' }),
    })
    assert.equal(response.status, 200, await response.text())
    const cookie = response.headers.get('set-cookie').split(';')[0]
    assert.equal((await request('/auth/me', { headers: { Cookie: cookie } })).status, 200)
  }
  await checkAuthentication()
  await delay(500)
  for (let round = 1; round <= 3; round++) {
    const previous = ctx.configManager.instances.get('rbac').fiber
    await writeFile(entry, `${original}\n// 第 ${round} 次真实文件热重载。\n`)
    await waitFor(() => ctx.configManager.instances.get('rbac')?.fiber !== previous)
    await ctx.configManager.instances.get('rbac').fiber.await()
    await ctx.configManager.instances.get('auth-local').fiber.await()
    assert.deepEqual(errors, [])
    assert.equal(ctx.server.address.port, port)
    assert.equal(ctx.configManager.instances.get('server').fiber, serverFiber)
    assert.equal(process.pid, pid)
    await checkAuthentication()
  }
  await ctx.fiber.dispose()
  assert.equal(ctx.rbac, undefined)
  assert.equal(ctx.server, undefined)
  console.log('RBAC HMR 验证通过')
} finally {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
