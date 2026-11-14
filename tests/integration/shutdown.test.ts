import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../', import.meta.url))

async function start(mode: 'development' | 'internal' | 'external') {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra shutdown '))
  const plugin = await mkdtemp(join(root, 'node_modules/antarestra-plugin-shutdown-'))
  const name = basename(plugin).toLowerCase()
  // 临时目录随机部分可能含大写，配置插件标识统一使用小写。
  const packagePath = join(root, 'node_modules', name)
  if (packagePath !== plugin) {
    const { rename } = await import('node:fs/promises')
    await rename(plugin, packagePath)
  }
  await writeFile(
    join(packagePath, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      exports: './index.mjs',
      keywords: ['antarestra-plugin'],
    }),
  )
  await copyFile(join(root, 'tests/fixtures/shutdown-plugin.mjs'), join(packagePath, 'index.mjs'))
  const events = join(directory, 'events.txt')
  const release = join(directory, 'release')
  const config = join(directory, 'main.yml')
  await writeFile(
    config,
    JSON.stringify({
      loader: {
        supervision: mode === 'external' ? 'external' : 'internal',
        disposalTimeoutMs: 100,
      },
      plugins: { [name]: { events, release } },
    }),
  )
  const child = spawn(
    process.execPath,
    [
      '--expose-internals',
      ...(mode === 'development' ? ['--import', 'tsx', '--conditions=development'] : []),
      join(root, mode === 'development' ? 'apps/server/src/index.ts' : 'apps/server/dist/index.js'),
      ...(mode === 'development' ? ['--watch'] : []),
      `--conf=${config}`,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  let output = ''
  child.stdout!.on('data', (chunk) => (output += String(chunk)))
  child.stderr!.on('data', (chunk) => (output += String(chunk)))
  const exited = once(child, 'exit')
  const readEvents = () => readFile(events, 'utf8').catch(() => '')
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await check()) return
      await delay(25)
    }
    throw new Error(`等待进程状态超时：${output}\n${await readEvents()}`)
  }
  const cleanup = async () => {
    await writeFile(release, '')
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'shutdown' }, () => {})
      await until(async () => child.exitCode !== null || child.signalCode !== null)
    }
    await rm(directory, { recursive: true, force: true })
    await rm(packagePath, { recursive: true, force: true })
  }
  return { child, exited, readEvents, until, cleanup, release, output: () => output }
}

it.each(['development', 'internal', 'external'] as const)(
  '首次关闭等待所有异步清理，超过清理超时仍正常退出：%s',
  async (mode) => {
    const run = await start(mode)
    try {
      await run.until(async () => (await run.readEvents()).includes('就绪:'))
      if (process.platform === 'win32') run.child.send({ type: 'shutdown' })
      else run.child.kill('SIGINT')
      await run.until(async () => (await run.readEvents()).includes('清理开始:'))
      // 超过原 tsx 的 5 秒上限，同时远超本测试配置的 100ms 清理超时。
      await delay(5200)
      expect(run.child.exitCode, run.output()).toBeNull()
      expect(run.child.signalCode).toBeNull()
      expect(await run.readEvents()).not.toContain('清理完成:')
      // 重复 IPC 请求应幂等，不能当作第二次 Ctrl+C。
      run.child.send({ type: 'shutdown' })
      await writeFile(run.release, '')
      await run.until(async () => run.child.exitCode !== null)
      expect((await run.exited)[0], run.output()).toBe(0)
      expect((await run.readEvents()).match(/清理开始:/g)).toHaveLength(1)
      expect(await run.readEvents()).toContain('清理完成:')
    } finally {
      await run.cleanup()
    }
  },
  15000,
)

it.skipIf(process.platform === 'win32').each(['development', 'internal', 'external'] as const)(
  '第二次 Ctrl+C 强制终止仍在清理的进程树：%s',
  async (mode) => {
    const run = await start(mode)
    try {
      await run.until(async () => (await run.readEvents()).includes('就绪:'))
      const [, worker, descendant] = /就绪:(\d+):(\d+)/.exec(await run.readEvents())!
      run.child.kill('SIGINT')
      await run.until(async () => (await run.readEvents()).includes('清理开始:'))
      run.child.kill('SIGINT')
      await run.until(async () => run.child.exitCode !== null)
      expect((await run.exited)[0], run.output()).toBe(130)
      expect(await run.readEvents()).not.toContain('清理完成:')
      for (const pid of [worker, descendant]) {
        await run.until(async () => {
          try {
            process.kill(Number(pid), 0)
            return false
          } catch {
            return true
          }
        })
      }
    } finally {
      await run.cleanup()
    }
  },
  15000,
)

it('源码变更先等待旧插件清理，再启动新业务进程', async () => {
  const run = await start('development')
  const source = join(root, 'packages/contracts/src/shutdown-watch-test.tmp')
  try {
    await run.until(async () => (await run.readEvents()).includes('就绪:'))
    await writeFile(source, '')
    await run.until(async () => (await run.readEvents()).includes('清理开始:'))
    await delay(250)
    expect((await run.readEvents()).match(/就绪:/g)).toHaveLength(1)
    await writeFile(run.release, '')
    await run.until(async () => (await run.readEvents()).split('就绪:').length === 3)
    expect(await run.readEvents()).toMatch(/清理完成:\d+\n就绪:/)
  } finally {
    await run.cleanup()
    await rm(source, { force: true })
  }
}, 15000)
