import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const password = 'supervisor-test-password'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it.each(['internal', 'external', 'development', 'local-overlay'] as const)(
  '真实进程监督与重启：%s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra restart '))
    const config = join(directory, 'main.yml')
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await writeFile(
      config,
      `loader: { supervision: ${mode === 'external' || mode === 'local-overlay' ? 'external' : 'internal'}, disposalTimeoutMs: 3000 }
plugins:
  database: {}
  plugin-database-kysely: { filename: ${JSON.stringify(join(directory, 'state.sqlite'))} }
  plugin-server: { host: '127.0.0.1', port: ${mode === 'local-overlay' ? 0 : port} }
  webui: {}
  rbac: {}
  plugin-auth-local: { bootstrapEmail: admin@example.com, bootstrapPassword: ${password} }
  plugin-admin-console: {}
  plugin-config-panel: {}
`,
    )
    const original = await readFile(config, 'utf8')
    if (mode === 'local-overlay') {
      await writeFile(
        join(directory, 'main.local.yml'),
        `loader: { supervision: internal }\nplugins: { plugin-server: { port: ${port} } }\n`,
      )
    }
    const child = spawn(
      process.execPath,
      mode === 'development'
        ? [
            fileURLToPath(import.meta.resolve('tsx/cli')),
            'watch',
            '--include',
            '../../packages/**/src/**',
            '--include',
            '../*/src/**',
            '--exclude',
            '../../plugins/**',
            '--expose-internals',
            '--conditions=development',
            'src/index.ts',
            `--conf=${config}`,
          ]
        : [
            '--expose-internals',
            '--import',
            'tsx',
            '--conditions=development',
            join(root, 'apps/server/src/index.ts'),
            `--conf=${config}`,
          ],
      {
        cwd: mode === 'development' ? join(root, 'apps/server') : root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    )
    let output = ''
    child.stdout!.on('data', (data) => {
      output += String(data)
    })
    child.stderr!.on('data', (data) => {
      output += String(data)
    })
    const exited = once(child, 'exit')
    const url = `http://127.0.0.1:${port}/api`
    let cookie = ''
    const request = (path: string, body?: object) =>
      fetch(url + path, {
        signal: AbortSignal.timeout(1000),
        method: body ? 'POST' : 'GET',
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        try {
          const result = await action()
          if (result !== undefined) return result
        } catch {
          /* 启动、重启中的连接恢复。 */
        }
        await pause(100)
      }
      throw new Error('进程恢复超时：' + output)
    }
    try {
      cookie = await until(async () => {
        const response = await request('/auth/local/local/login', {
          email: 'admin@example.com',
          password,
        })
        return response.status === 200
          ? response.headers.get('set-cookie')!.split(';')[0]
          : undefined
      })
      const before = await until(async () => {
        const response = await request('/plugin-config-panel/restart')
        return response.ok
          ? ((await response.json()) as { generation: string; processId: number })
          : undefined
      })
      expect((await request('/plugin-config-panel/restart', { password })).status).toBe(202)
      if (mode === 'external') {
        const result = await Promise.race([
          exited,
          pause(8000).then(() => {
            throw new Error('外部模式没有退出')
          }),
        ])
        expect(result[0]).toBe(75)
      } else {
        const after = await until(async () => {
          const response = await request('/plugin-config-panel/restart')
          if (response.status === 401) {
            const login = await request('/auth/local/local/login', {
              email: 'admin@example.com',
              password,
            })
            if (login.ok) cookie = login.headers.get('set-cookie')!.split(';')[0]!
            return
          }
          if (!response.ok) return
          const data = (await response.json()) as { generation: string; processId: number }
          return data.generation !== before.generation ? data : undefined
        })
        expect(after.processId).not.toBe(before.processId)
        expect(child.exitCode).toBeNull()
      }
      if (mode === 'local-overlay') expect(await readFile(config, 'utf8')).toBe(original)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        if (mode === 'development' && process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          await once(killer, 'exit')
        } else if (child.connected) child.send({ type: 'shutdown' })
        else child.kill('SIGTERM')
        await Promise.race([exited, pause(5000).then(() => child.kill('SIGKILL'))])
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    }
  },
  25000,
)
