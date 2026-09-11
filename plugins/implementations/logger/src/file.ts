import { mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Config } from './config.js'
import { localDate } from './format.js'

// 这里只维护进程级文件资源互斥，不保存账号、消息或插件配置。
const occupiedDirectories = new Set<string>()

export class FileWriter {
  private handle: FileHandle | undefined
  private directory = ''
  private lease = ''
  private date = ''
  private sequence = 0
  private size = 0
  private queue: Promise<void> = Promise.resolve()
  private failure: unknown
  private failed = false
  private closed = false
  private closing: Promise<void> | undefined

  constructor(private readonly config: Required<Config>) {}

  async init(): Promise<void> {
    await mkdir(resolve(this.config.directory), { recursive: true })
    this.directory = await realpath(resolve(this.config.directory))
    this.lease = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory
    if (occupiedDirectories.has(this.lease)) throw new Error('日志目录已被其他输出器占用')
    occupiedDirectories.add(this.lease)
    try {
      if (this.config.rotation === 'size') {
        for (const filename of await readdir(this.directory)) {
          const match = /^antarestra-size-(\d+)\.log$/.exec(filename)
          if (!match) continue
          const sequence = Number(match[1])
          if (!Number.isSafeInteger(sequence)) throw new Error('日志文件序号超出安全范围')
          this.sequence = Math.max(this.sequence, sequence)
        }
      }
      await this.select(Date.now(), 0)
    } catch (error) {
      try {
        await this.handle?.close()
      } finally {
        occupiedDirectories.delete(this.lease)
      }
      throw error
    }
  }

  write(content: string, timestamp: number): void {
    if (this.closed || this.failed) return
    this.queue = this.queue
      .then(async () => {
        if (this.failed) return
        const bytes = Buffer.byteLength(content)
        await this.select(timestamp, bytes)
        await this.handle!.appendFile(content, 'utf8')
        this.size += bytes
      })
      .catch((error: unknown) => {
        this.failed = true
        this.failure = error
        // 不再调用 logger，避免文件输出故障递归；不打印可能含敏感内容的消息。
        process.stderr.write('[error] 日志文件写入失败，已停止文件输出\n')
      })
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= this.finish())
  }

  private async finish(): Promise<void> {
    try {
      await this.queue
      await this.handle?.close()
      this.handle = undefined
      if (this.failed) throw new Error('日志文件输出失败', { cause: this.failure })
    } finally {
      occupiedDirectories.delete(this.lease)
    }
  }

  private async select(timestamp: number, bytes: number): Promise<void> {
    const { rotation } = this.config
    if (rotation === 'daily') {
      const date = localDate(timestamp)
      if (date !== this.date) {
        await this.switchFile(`antarestra-${date}.log`)
        this.date = date
        await this.prune(date)
      }
    } else if (rotation === 'size') {
      if (!this.handle) await this.switchFile(this.sizeFilename())
      if (this.size > 0 && this.size + bytes > this.config.maxSize) {
        if (!Number.isSafeInteger(++this.sequence)) throw new Error('日志文件序号超出安全范围')
        await this.switchFile(this.sizeFilename())
      }
    } else if (!this.handle) {
      await this.switchFile('antarestra.log')
    }
  }

  private sizeFilename(): string {
    return `antarestra-size-${String(this.sequence).padStart(6, '0')}.log`
  }

  private async switchFile(filename: string): Promise<void> {
    await this.handle?.close()
    this.handle = undefined
    this.handle = await open(join(this.directory, filename), 'a')
    const stat = await this.handle.stat()
    if (!stat.isFile()) throw new Error('日志输出路径必须是普通文件')
    this.size = stat.size
  }

  private async prune(today: string): Promise<void> {
    // 用 UTC 日期序号比较本地日历日期，避免夏令时导致一天不等于 24 小时。
    const cutoff = Date.parse(`${today}T00:00:00Z`) / 86400000 - this.config.retentionDays + 1
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      const match = /^antarestra-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name)
      if (!entry.isFile() || !match) continue
      const date = new Date(`${match[1]}T00:00:00Z`)
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) continue
      if (date.getTime() / 86400000 < cutoff) await unlink(join(this.directory, entry.name))
    }
  }
}
