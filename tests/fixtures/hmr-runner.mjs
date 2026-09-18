import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@antarestra/plugin-sdk'
import * as configLoader from '@antarestra/config-loader'
const { createPluginResolver, loadPlugins } = configLoader
const managed = process.env.ANTARESTRA_TEST_MANAGED_HMR === '1'

const directory = await mkdtemp(join(tmpdir(), 'antarestra hmr '))
const ctx = new Context()
ctx.logger.exporter({ export: (message) => console.log(message) })
const state = (globalThis.hmrTest = { active: new Map(), starts: new Map(), cleanups: new Map() })
const plugin = (id, config = {}) => ({ pluginId: id, instanceId: id, enabled: true, config })
const urls = { hmr: import.meta.resolve('@antarestra/plugin-hmr') }
const source = (value) => `export const value: string = ${JSON.stringify(value)}\n`
const entry = `
import { value } from './value.js'
export function apply(ctx, { id }) {
  const state = globalThis.hmrTest
  if (state.active.has(id)) throw new Error('旧实例尚未清理')
  if (value === '启动失败') throw new Error('预期的启动失败')
  state.active.set(id, value)
  state.starts.set(id, (state.starts.get(id) || 0) + 1)
  ctx.effect(() => async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    state.active.delete(id)
    state.cleanups.set(id, (state.cleanups.get(id) || 0) + 1)
  })
}
`

async function fixture(id) {
  const path = join(directory, 'plugins', id)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({
      type: 'module',
      name: id,
      keywords: ['antarestra-plugin'],
      antarestra: { multipleInstances: true },
    }),
  )
  await writeFile(join(path, 'value.ts'), source('初始'))
  await writeFile(join(path, 'index.ts'), entry)
  urls[id] = pathToFileURL(join(path, 'index.ts')).href
  return join(path, 'value.ts')
}

async function waitFor(predicate) {
  const until = Date.now() + 6000
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`等待超时：${JSON.stringify([...state.active])}`)
    await delay(40)
  }
}

try {
  const changed = await fixture('changed')
  const excluded = await fixture('excluded')
  const sibling = await fixture('excluded-sibling')
  await fixture('unrelated')
  await writeFile(
    join(directory, 'plugins', 'package.json'),
    JSON.stringify({
      type: 'module',
      name: 'fixture-services',
      keywords: ['antarestra-plugin'],
      antarestra: { multipleInstances: true },
    }),
  )
  const serviceFile = join(directory, 'plugins', 'service.mjs')
  const serviceSource = (value) => `
    import { Service } from ${JSON.stringify(import.meta.resolve('@antarestra/plugin-sdk'))}
    export default class extends Service {
      constructor(ctx) { super(ctx, 'hmrProbe'); this.value = ${JSON.stringify(value)} }
    }
  `
  await writeFile(serviceFile, serviceSource('服务初始'))
  urls.service = pathToFileURL(serviceFile).href
  const consumerFile = join(directory, 'plugins', 'consumer.mjs')
  await writeFile(
    consumerFile,
    `
    export const inject = ['hmrProbe']
    export function apply(ctx) {
      globalThis.hmrTest.active.set('consumer', ctx.hmrProbe.value)
      ctx.effect(() => () => globalThis.hmrTest.active.delete('consumer'))
    }
  `,
  )
  urls.consumer = pathToFileURL(consumerFile).href
  const resolver = createPluginResolver((id) => {
    const url = urls[id.replace('@antarestra/', '')]
    if (!url) throw Object.assign(new Error('不存在'), { code: 'ERR_MODULE_NOT_FOUND' })
    return url
  })
  let instances
  await ctx.plugin(async (scope) => {
    const entries = [
      plugin('hmr', { include: ['plugins', 'plugins/excluded'], exclude: ['plugins/excluded'] }),
      plugin('changed', { id: 'a' }),
      { ...plugin('changed', { id: 'b' }), instanceId: 'changed:1234abcd' },
      plugin('excluded', { id: 'excluded' }),
      plugin('excluded-sibling', { id: 'sibling' }),
      plugin('unrelated', { id: 'unrelated' }),
      plugin('consumer'),
      plugin('service'),
    ]
    const baseUrl = pathToFileURL(directory + sep).href
    if (managed) {
      const filename = join(directory, 'main.yml')
      await writeFile(
        filename,
        JSON.stringify({
          plugins: Object.fromEntries(entries.map((item) => [item.instanceId, item.config])),
        }),
      )
      await scope.plugin(configLoader, { filename, resolvePlugin: resolver, baseUrl })
      instances = { get: (id) => ctx.configManager.instances.get(id)?.fiber }
    } else instances = await loadPlugins(scope, entries, resolver, baseUrl)
  })
  const originalPid = process.pid
  await delay(500)
  await writeFile(changed, source('更新'))
  await waitFor(() => state.active.get('a') === '更新' && state.active.get('b') === '更新')
  assert.equal(state.cleanups.get('a'), 1)
  assert.equal(state.starts.get('unrelated'), 1)
  assert.equal(process.pid, originalPid)
  await writeFile(serviceFile, serviceSource('服务已替换'))
  await waitFor(() => state.active.get('consumer') === '服务已替换')
  await writeFile(excluded, source('不应生效'))
  await writeFile(sibling, source('相邻目录生效'))
  await waitFor(() => state.active.get('sibling') === '相邻目录生效')
  assert.equal(state.active.get('excluded'), '初始')
  await writeFile(changed, 'export const value = ;')
  await delay(700)
  assert.equal(state.active.get('a'), '更新')
  await writeFile(changed, source('修复'))
  await waitFor(() => state.active.get('a') === '修复')
  await writeFile(changed, source('启动失败'))
  await waitFor(() => !state.active.has('a') && !state.active.has('b'))
  await writeFile(changed, source('再次恢复'))
  await waitFor(() => state.active.get('a') === '再次恢复' && state.active.get('b') === '再次恢复')
  if (managed) {
    const version = (await ctx.configManager.snapshot()).version
    const task = ctx.configManager.enqueue((operation) =>
      ctx.configManager.save(version, 'changed', '{ id: a, updated: true }', true, '', operation),
    )
    await writeFile(changed, source('配置与源码交错'))
    await waitFor(
      () =>
        ctx.configManager.operation(task.id).state === 'completed' &&
        state.active.get('a') === '配置与源码交错',
    )
    assert.equal(state.starts.get('unrelated'), 1)
  }
  // 加载器返回的映射也必须指向热替换后的 Fiber。
  await instances.get('changed:1234abcd').dispose()
  await writeFile(changed, source('独立运行'))
  await waitFor(() => state.active.get('a') === '独立运行')
  assert.equal(state.active.has('b'), false)
  await instances.get('hmr').dispose()
  assert.equal(ctx.timer, undefined)
  assert.equal(ctx.hmr, undefined)
  await writeFile(changed, source('停止监视'))
  await delay(600)
  assert.equal(state.active.get('a'), '独立运行')
  await ctx.fiber.dispose()
  assert.equal(state.active.size, 0)
  console.log('HMR 验证通过')
} finally {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
