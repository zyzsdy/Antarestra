import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const envFile = resolve('.env.storage.local')
if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    `ANTARESTRA_S3_ACCESS_KEY=${randomBytes(12).toString('hex')}\nANTARESTRA_S3_SECRET_KEY=${randomBytes(32).toString('hex')}\n`,
    { flag: 'wx' },
  )
}
const result = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    envFile,
    '-p',
    'antarestra-storage',
    '-f',
    'compose.storage.yml',
    'up',
    '-d',
  ],
  { stdio: 'inherit', windowsHide: true },
)
if (result.error) throw result.error
if (result.status) process.exit(result.status)
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:19000/health', {
      signal: AbortSignal.timeout(2000),
    })
    if (response.ok) {
      console.log(
        'RustFS 已就绪：S3 http://127.0.0.1:19000，控制台 http://127.0.0.1:19001；凭据位于 .env.storage.local。',
      )
      process.exit(0)
    }
  } catch {
    /* 等待容器就绪。 */
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
throw new Error('RustFS 未在 60 秒内就绪，请检查 docker compose 日志')
