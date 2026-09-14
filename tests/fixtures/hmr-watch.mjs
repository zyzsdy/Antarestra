import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = await mkdtemp(join(root, 'plugins', 'hmr-test-'))
const packageDirectory = await mkdtemp(join(root, 'packages', 'hmr-test-'))
const entryFile = join(root, 'apps/server/src', `hmr-test-${process.pid}.mjs`)
const pluginFile = join(directory, 'index.ts')
const packageFile = join(packageDirectory, 'src/value.ts')
let child
let output = ''
const starts = []
const pluginSource = (value) => `
  export const inject = ['server']
  export function apply(ctx) {
    ctx.server.route(ctx, 'GET', '/hmr-test', (http) => {
      http.body = { value: ${JSON.stringify(value)}, pid: process.pid }
    })
  }
`

async function waitFor(predicate) {
  const until = Date.now() + 7000
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`开发监视验证超时：${output}`)
    await delay(60)
  }
}

try {
  await mkdir(join(packageDirectory, 'src'))
  await writeFile(packageFile, 'export const value = 1\n')
  await writeFile(pluginFile, pluginSource('初始'))
  await writeFile(
    entryFile,
    `
    import { Context } from ${JSON.stringify(import.meta.resolve('@antarestra/plugin-sdk'))}
    import { loadPlugins, createPluginResolver } from ${JSON.stringify(import.meta.resolve('@antarestra/config-loader'))}
    const ctx = new Context()
    const urls = ${JSON.stringify({
      hmr: import.meta.resolve('@antarestra/plugin-hmr'),
      server: import.meta.resolve('@antarestra/plugin-server'),
      probe: pathToFileURL(pluginFile).href,
    })}
    const resolver = createPluginResolver(id => urls[id.replace('@antarestra/', '')])
    await loadPlugins(ctx, [
      ['hmr', {}], ['server', { host: '127.0.0.1', port: 0 }], ['probe', {}],
    ].map(([id, config]) => ({ pluginId: id, instanceId: id, enabled: true, config })), resolver,
      ${JSON.stringify(pathToFileURL(root).href)})
    console.log('READY ' + JSON.stringify({ port: ctx.server.address.port, pid: process.pid }))
    process.once('SIGTERM', () => { void ctx.fiber.dispose() })
  `,
  )
  // 直接复用服务端开发命令的参数，避免测试与实际 watch 排除规则分离。
  const manifest = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'))
  const args = [...manifest.scripts.dev.matchAll(/'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2],
  )
  args.shift()
  args[args.length - 1] = entryFile
  child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('tsx/cli')), ...args], {
    cwd: join(root, 'apps/server'),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let pending = ''
  child.stdout.on('data', (data) => {
    output += data.toString()
    pending += data.toString()
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (line.startsWith('READY ')) starts.push(JSON.parse(line.slice(6)))
    }
  })
  child.stderr.on('data', (data) => {
    output += data.toString()
  })
  await waitFor(() => starts.length === 1)
  await delay(400)
  const original = starts[0]
  await writeFile(pluginFile, pluginSource('热更新'))
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${original.port}/api/hmr-test`)
    const body = await response.json()
    return body.value === '热更新' && body.pid === original.pid
  })
  await delay(400)
  assert.equal(starts.length, 1, '插件修改不应触发 tsx 重启')
  await writeFile(packageFile, 'export const value = 2\n')
  await waitFor(() => starts.length === 2)
  assert.notEqual(starts[1].pid, original.pid)
  await writeFile(entryFile, (await readFile(entryFile, 'utf8')) + '\n// apps 更新\n')
  await waitFor(() => starts.length === 3)
  assert.notEqual(starts[2].pid, starts[1].pid)
  console.log('开发监视验证通过')
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      await once(killer, 'exit')
    } else {
      child.kill('SIGTERM')
    }
    await exited
  }
  await rm(entryFile, { force: true })
  await rm(directory, { recursive: true, force: true })
  await rm(packageDirectory, { recursive: true, force: true })
}
