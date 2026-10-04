import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { imageSize } from 'image-size'
import { Http } from '@antarestra/http'
import type { Context } from '@antarestra/plugin-sdk'
import type { JsonObject, RunContext, StructuredToolResult } from '@antarestra/ai'
import { editCommand } from './edit.js'
import { bashCommand, bashOutputPath } from './bash.js'

export interface Config {
  url: string
  apiKey: string
}

const maxBytes = 50 * 1024
const maxLines = 2000
const sessionId = 'antarestra-open-terminal'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Open Terminal 返回了无效数据')
  return value as Record<string, unknown>
}

export function tailText(text: string, byteLimit = maxBytes) {
  const lines = text.split('\n')
  const bytes = Buffer.from(lines.slice(-maxLines).join('\n'))
  let start = Math.max(0, bytes.length - byteLimit)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return {
    text: bytes.subarray(start).toString('utf8'),
    truncated: start > 0 || lines.length > maxLines,
  }
}

export class TerminalClient {
  private readonly transport: typeof Http.undici
  private readonly dispatcher: InstanceType<typeof Http.undici.Agent>
  private readonly stopped = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly baseUrl: string

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    const url = new URL(config.url)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('连接 URL 必须是无凭据、查询参数和片段的 HTTP(S) 地址')
    if (!config.apiKey.trim() || /[\r\n]/.test(config.apiKey)) throw new Error('API 密钥无效')
    this.baseUrl = url.href.replace(/\/+$/, '')
    this.transport = ctx.http.undici
    // 使用 HTTP 服务提供的 Undici，但独立管理连接池：卸载时仍需发送远端进程清理请求。
    this.dispatcher = new this.transport.Agent()
    ctx.effect(() => () => this.dispose())
  }

  private async dispose() {
    this.stopped.abort(new Error('远端终端插件已卸载'))
    await Promise.allSettled([...this.pending])
    await this.dispatcher.destroy()
  }

  async execute(id: string, args: JsonObject, context: RunContext): Promise<StructuredToolResult> {
    const signal = AbortSignal.any([this.stopped.signal, context.signal])
    const task = this.queue.then(async () => {
      signal.throwIfAborted()
      let bashPath: string | undefined
      try {
        if (id === 'bash' || id === 'edit') {
          const timeout = id === 'bash' ? args.timeout : 60
          const controller = new AbortController()
          const timer =
            typeof timeout === 'number'
              ? setTimeout(() => controller.abort(new Error('远端命令执行超时')), timeout * 1000)
              : undefined
          try {
            const outputPath = bashOutputPath(randomUUID())
            if (id === 'bash') bashPath = outputPath
            const result = await this.command(
              id === 'bash' ? bashCommand(String(args.command), outputPath) : editCommand(args),
              AbortSignal.any([signal, controller.signal]),
              512 * 1024,
            )
            if (id === 'edit' && result.isError) return result
            const content = object(result.content)
            let summary: Record<string, unknown>
            try {
              summary = this.json({ bytes: Buffer.from(String(content.output)) })
            } catch {
              throw new Error(
                `远端 ${id} 未返回有效摘要（需要 bash 和 python3）：${String(content.output).slice(0, 1000)}`,
              )
            }
            if (typeof summary.output !== 'string' || typeof summary.truncated !== 'boolean')
              throw new Error(`远端 ${id} 未返回有效输出摘要`)
            return {
              ...result,
              content: {
                ...(result.content as JsonObject),
                output: summary.output || '（无输出）',
                ...(id === 'bash' ? { outputPath } : {}),
                truncated: summary.truncated,
              },
            }
          } finally {
            clearTimeout(timer)
          }
        }
        if (id === 'read') return await this.read(args, context, signal)
        const result = this.json(await this.request('/files/write', 'POST', args, signal))
        if (typeof result.path !== 'string' || typeof result.size !== 'number')
          throw new Error('Open Terminal 写入响应无效，未自动重试，请检查远端文件')
        return { content: `已写入 ${result.path}（${result.size} 字节）` }
      } catch (error) {
        signal.throwIfAborted()
        return {
          isError: true,
          content:
            this.message(error) +
            (bashPath ? `\n若远端命令已启动，可使用 \`read\` 读取 ${bashPath}` : ''),
        }
      }
    })
    this.queue = task.catch(() => {})
    this.pending.add(task)
    try {
      return await task
    } finally {
      this.pending.delete(task)
    }
  }

  private message(error: unknown) {
    return (error instanceof Error ? error.message : '远端终端调用失败').replaceAll(
      this.config.apiKey,
      '[已隐藏]',
    )
  }

  private async request(path: string, method: string, body?: JsonObject, signal?: AbortSignal) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('Open Terminal 请求超时')), 30000)
    const combined = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])])
    try {
      const response = await this.transport.fetch(this.baseUrl + path, {
        method,
        dispatcher: this.dispatcher,
        redirect: 'error',
        signal: combined,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'X-Session-Id': sessionId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 12 * 1024 ** 2) {
            timeout.abort()
            throw new Error('Open Terminal 响应超过 12 MiB，请缩小读取范围或限制命令输出')
          }
          chunks.push(chunk)
        }
      }
      const bytes = Buffer.concat(chunks)
      if (!response.ok) {
        let detail = ''
        try {
          const value = object(JSON.parse(bytes.toString('utf8')))
          if (typeof value.detail === 'string') detail = `：${value.detail.slice(0, 1000)}`
        } catch {
          /* 非 JSON 错误正文不传播，避免输出代理页面。 */
        }
        throw new Error(`Open Terminal 返回 HTTP ${response.status}${detail}`)
      }
      return { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? '' }
    } catch (error) {
      if (error instanceof TypeError)
        throw new Error('Open Terminal 连接失败，请检查连接 URL 和服务状态')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private json(response: { bytes: Buffer }) {
    try {
      return object(JSON.parse(response.bytes.toString('utf8')))
    } catch {
      throw new Error('Open Terminal 返回了无效 JSON，未自动重试')
    }
  }

  private async command(
    command: string,
    signal: AbortSignal,
    byteLimit = maxBytes,
  ): Promise<StructuredToolResult> {
    signal.throwIfAborted()
    // 先取得进程 ID，再响应取消，避免取消创建请求后遗失正在远端运行的进程。
    let state = this.json(await this.request('/execute?wait=0&tail=2000', 'POST', { command }))
    if (typeof state.id !== 'string' || !state.id)
      throw new Error('远端未返回进程 ID，无法确认命令状态；未自动重试')
    const id = encodeURIComponent(state.id)
    let finished = false
    let output = ''
    let truncated = false
    let logPath: string | null = null
    try {
      for (;;) {
        signal.throwIfAborted()
        if (!Array.isArray(state.output) || !Number.isSafeInteger(state.next_offset))
          throw new Error('Open Terminal 进程响应无效')
        const text = state.output
          .map((entry) => {
            const item = object(entry)
            return ['output', 'stdout', 'stderr'].includes(String(item.type)) &&
              typeof item.data === 'string'
              ? item.data
              : ''
          })
          .join('')
        const tail = tailText(output + text, byteLimit)
        output = tail.text
        truncated ||= tail.truncated || state.truncated === true
        if (typeof state.log_path === 'string') logPath = state.log_path
        if (state.status !== 'running') {
          if (
            !['done', 'killed'].includes(String(state.status)) ||
            typeof state.exit_code !== 'number'
          )
            throw new Error('Open Terminal 未返回有效的命令退出状态')
          finished = true
          return {
            content: {
              output: output || '（无输出）',
              exitCode: state.exit_code,
              truncated,
              ...(truncated
                ? {
                    logPath,
                    note: '仅保留末尾 2000 行 / 50 KiB；远端 JSONL 日志可用 read 继续读取，日志轮转时更早输出可能已丢弃。',
                  }
                : {}),
            },
            isError: state.exit_code !== 0 || state.status === 'killed',
          }
        }
        await delay(100, undefined, { signal })
        state = this.json(
          await this.request(
            `/execute/${id}/status?wait=1&offset=${state.next_offset}&tail=2000`,
            'GET',
            undefined,
            signal,
          ),
        )
      }
    } finally {
      if (!finished) {
        try {
          await this.request(`/execute/${id}?force=true`, 'DELETE')
        } catch (error) {
          this.ctx.logger.warn('清理远端进程 %s 失败：%s', id, this.message(error))
          throw new Error(`无法确认远端进程 ${id} 已停止：${this.message(error)}`)
        }
      }
    }
  }

  private async read(
    args: JsonObject,
    context: RunContext,
    signal: AbortSignal,
  ): Promise<StructuredToolResult> {
    const offset = typeof args.offset === 'number' ? args.offset : 1
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, maxLines) : maxLines
    const query = new URLSearchParams({
      path: String(args.path),
      start_line: String(offset),
      end_line: String(offset + limit - 1),
    })
    const response = await this.request(`/files/read?${query}`, 'GET', undefined, signal)
    if (response.mime.startsWith('image/')) {
      if (
        !/^image\/(png|jpeg|gif|webp)$/.test(response.mime) ||
        response.bytes.length > 8 * 1024 ** 2
      )
        throw new Error('图片仅支持 PNG、JPEG、GIF、WebP，且不得超过 8 MiB')
      const { width, height } = imageSize(response.bytes)
      const image = await this.ctx.ai.storeToolImage(context, {
        data: response.bytes,
        mimeType: response.mime,
        width,
        height,
        filename: String(args.path).split(/[\\/]/).pop()!.slice(-255),
        signal,
      })
      return { content: `已读取远端图片 ${args.path}`, images: [image] }
    }
    const value = this.json(response)
    if (
      typeof value.content !== 'string' ||
      !Number.isSafeInteger(value.total_lines) ||
      Number(value.total_lines) < 0
    )
      throw new Error('Open Terminal 文件响应无效')
    const total = Number(value.total_lines)
    if (offset > Math.max(1, total)) throw new Error(`offset=${offset} 超过文件总行数 ${total}`)
    const lines = value.content.match(/[^\n]*\n|[^\n]+$/g) ?? []
    let output = ''
    let count = 0
    let size = 0
    for (const line of lines) {
      size += Buffer.byteLength(line)
      if (size > maxBytes) break
      output += line
      count++
    }
    if (lines.length && !count)
      return { content: `第 ${offset} 行超过 50 KiB，请使用 bash 分段读取该行。` }
    const next = offset + count
    return {
      content:
        output +
        (next <= total
          ? `\n\n[已显示第 ${offset}–${next - 1} 行，共 ${total} 行；使用 offset=${next} 继续读取。]`
          : ''),
    }
  }
}
