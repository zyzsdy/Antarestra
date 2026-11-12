import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AuthError } from '@antarestra/rbac'
import type { CodexState } from './codex-types.js'

/** 一个凭据目录仅允许一个服务进程使用，避免轮换刷新令牌的跨进程竞争。 */
export class CodexStorage {
  readonly directory: string
  private handle: FileHandle | undefined
  constructor(directory: string) {
    this.directory = resolve(directory)
  }
  async read(): Promise<CodexState | undefined> {
    try {
      const state = JSON.parse(
        await readFile(join(this.directory, 'accounts.json'), 'utf8'),
      ) as CodexState
      if (state.version !== 1 || typeof state.hostId !== 'string' || !Array.isArray(state.accounts))
        throw new Error('凭据文件格式无效')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new AuthError(500, '订阅凭据文件无法读取，请检查文件权限与格式')
    }
  }
  async lock() {
    if (this.handle) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      this.handle = await open(join(this.directory, '.lock'), 'wx', 0o600)
      await this.handle.writeFile(String(process.pid))
    } catch {
      throw new AuthError(
        503,
        '订阅凭据目录正在使用；若上次进程异常退出，请确认已停止后移除该目录的 .lock 文件',
      )
    }
  }
  async write(state: CodexState) {
    await this.lock()
    const temporary = join(this.directory, `accounts.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(state))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, join(this.directory, 'accounts.json'))
    } finally {
      await rm(temporary, { force: true })
    }
  }
  async close() {
    if (!this.handle) return
    await this.handle.close()
    this.handle = undefined
    await rm(join(this.directory, '.lock'), { force: true })
  }
}
