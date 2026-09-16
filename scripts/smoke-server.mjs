import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// 持续运行的 HTTP 服务不能直接作为 CI 的阻塞命令；验证后回收子进程。
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'antarestra-smoke-'))
let child
try {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  )
  const filename = join(temporary, 'antarestra.yml')
  const config = await readFile(join(root, 'antarestra.yml'), 'utf8')
  await writeFile(
    filename,
    config
      .replace('plugin-server: {}', `plugin-server: { host: 127.0.0.1, port: ${port} }`)
      .replace(
        /plugin-database-kysely:(?: \{\}|\r?\n    type: postgresql\r?\n    url: \$ANTARESTRA_DATABASE_URL)/,
        `plugin-database-kysely: ${JSON.stringify({ filename: join(temporary, 'smoke.sqlite') })}`,
      ),
  )
  child = spawn(
    process.execPath,
    ['--expose-internals', 'apps/server/dist/index.js', `--conf=${filename}`],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  const exited = once(child, 'exit')
  let healthy = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('服务端在健康检查前退出')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      })
      const body = await response.json()
      healthy =
        response.status === 200 &&
        body.status === 'ok' &&
        Number.isFinite(Date.parse(body.time)) &&
        Object.keys(body).length === 2
      if (healthy) {
        const page = await fetch(`http://127.0.0.1:${port}/auth/user/`, {
          signal: AbortSignal.timeout(1000),
        })
        const identity = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
          signal: AbortSignal.timeout(1000),
        })
        healthy =
          page.status === 200 &&
          (await page.text()).includes('<div id="app"></div>') &&
          identity.status === 401
        if (healthy) {
          const entries = await (
            await fetch('http://127.0.0.1:' + port + '/webui/entries.json')
          ).json()
          const entry = entries.find((item) => item.id === 'auth-local-local')
          const chat = entries.find((item) => item.id === 'chat-webui')
          const admin = entries.find((item) => item.id === 'admin-console')
          healthy = entry?.config.path === '/auth/user/' && !!chat && !!admin
          if (healthy) {
            const resource = await fetch('http://127.0.0.1:' + port + entry.url)
            healthy =
              resource.status === 200 &&
              resource.headers.get('content-type')?.includes('javascript')
            const access = await fetch(`http://127.0.0.1:${port}/api/chat-webui/session`)
            const chatResource = await fetch(`http://127.0.0.1:${port}${chat.url}`)
            const adminAccess = await fetch(`http://127.0.0.1:${port}/api/admin-console/session`)
            const adminResource = await fetch(`http://127.0.0.1:${port}${admin.url}`)
            const adminPage = await fetch(`http://127.0.0.1:${port}/admin`)
            healthy =
              healthy &&
              access.status === 401 &&
              (await access.json()).loginPath === '/auth/user/' &&
              chatResource.status === 200 &&
              adminAccess.status === 401 &&
              (await adminAccess.json()).loginPath === '/auth/user/' &&
              adminResource.status === 200 &&
              adminPage.status === 200
          }
        }
        if (healthy) break
      }
    } catch {
      // 启动过程中短暂拒绝连接是正常情况。
    }
    await delay(100)
  }
  if (!healthy) throw new Error('编译产物健康检查失败')
  console.log('编译产物健康接口、认证、聊天与后台扩展、未登录拒绝检查通过')
  child.kill('SIGTERM')
  await exited
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  await rm(temporary, { recursive: true, force: true })
}
