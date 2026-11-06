import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@antarestra/plugin-sdk'
import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Transport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { AuthError } from '@antarestra/rbac'
import type { Tool, JsonObject } from '@antarestra/ai'
import { name, type Tables } from './store.js'
import { validate } from './validation.js'
import { toolResult } from './results.js'
import type { ServerRecord, ServerView } from './types.js'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    mcp: McpService
  }
}
interface Connection {
  client: Client
  transport: Transport
  controller: AbortController
  release: (() => Promise<void>)[]
  closed: boolean
  close: () => Promise<void>
}
interface Entry {
  record: ServerRecord
  status: ServerView['status']
  error: string
  tools: ServerView['tools']
  connection?: Connection
}
export class McpService extends Service {
  private entries = new Map<string, Entry>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(ctx: Context) {
    super(ctx, 'mcp')
    ctx.effect(() => async () => {
      this.closing = true
      for (const entry of this.entries.values()) entry.connection?.controller.abort()
      await this.queue
      await Promise.all([...this.entries.values()].map((entry) => this.disconnect(entry)))
      this.entries.clear()
    })
  }
  private db() {
    return this.ctx.database.scope<Tables>(this.ctx, name)
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closing) throw new AuthError(503, 'MCP 服务已卸载')
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }
  initialize() {
    return this.lock(async () => {
      const rows = await this.db()
        .selectFrom('servers')
        .selectAll()
        .orderBy('position')
        .orderBy('id')
        .execute()
      for (const row of rows) {
        const record = JSON.parse(row.payload) as ServerRecord
        const entry: Entry = { record, status: 'disabled', error: '', tools: [] }
        this.entries.set(record.id, entry)
        if (record.enabled && !this.closing) await this.connect(entry)
      }
    })
  }
  private entry(id: string) {
    const entry = this.entries.get(id)
    if (!entry) throw new AuthError(404, 'MCP 服务器不存在')
    return entry
  }
  private view(entry: Entry): ServerView {
    const { headers, env, ...record } = entry.record
    return structuredClone({
      ...record,
      headers: Object.fromEntries(Object.keys(headers).map((key) => [key, null])),
      env: Object.fromEntries(Object.keys(env).map((key) => [key, null])),
      status: entry.status,
      error: entry.error,
      tools: entry.tools,
    })
  }
  list() {
    return [...this.entries.values()].map((entry) => this.view(entry))
  }
  save(body: Record<string, unknown>, id?: string) {
    return this.lock(async () => {
      const previous = id ? this.entry(id) : undefined
      if (previous && previous.record.revision !== body.revision)
        throw new AuthError(409, '配置已变化，请关闭编辑器并刷新后重试')
      const value = validate(body, previous?.record)
      const record: ServerRecord = {
        ...value,
        id: id ?? randomUUID(),
        revision: previous ? previous.record.revision + 1 : 1,
        order:
          previous?.record.order ??
          Math.max(0, ...[...this.entries.values()].map((entry) => entry.record.order)) + 1,
      }
      if (previous)
        await this.db()
          .updateTable('servers')
          .set({ payload: JSON.stringify(record) })
          .where('id', '=', record.id)
          .execute()
      else
        await this.db()
          .insertInto('servers')
          .values({ id: record.id, payload: JSON.stringify(record), position: record.order })
          .execute()
      if (previous) await this.disconnect(previous)
      const entry: Entry = { record, status: 'disabled', error: '', tools: [] }
      this.entries.set(record.id, entry)
      if (record.enabled && !this.closing) await this.connect(entry)
      return this.view(entry)
    })
  }
  reconnect(id: string, revision: unknown) {
    return this.lock(async () => {
      const entry = this.entry(id)
      if (entry.record.revision !== revision) throw new AuthError(409, '配置已变化，请刷新后重试')
      if (!entry.record.enabled) throw new AuthError(400, '请先启用服务器')
      await this.disconnect(entry)
      await this.connect(entry)
      return this.view(entry)
    })
  }
  remove(id: string, revision: unknown) {
    return this.lock(async () => {
      const entry = this.entry(id)
      if (entry.record.revision !== revision) throw new AuthError(409, '配置已变化，请刷新后重试')
      await this.db().deleteFrom('servers').where('id', '=', id).execute()
      await this.disconnect(entry)
      this.entries.delete(id)
      return { success: true }
    })
  }
  private async disconnect(entry: Entry) {
    const connection = entry.connection
    if (!connection) return
    delete entry.connection
    connection.closed = true
    connection.controller.abort()
    await Promise.all(connection.release.splice(0).map((release) => release()))
    await connection.close()
    entry.tools = []
  }
  private async connect(entry: Entry) {
    const record = entry.record
    entry.status = 'connecting'
    entry.error = ''
    const client = new Client({ name: 'Antarestra', version: '0.1.0' })
    const controller = new AbortController()
    const remoteFetch: typeof fetch = (url, options) =>
      fetch(url, {
        ...options,
        ...(options?.method === 'DELETE'
          ? {
              signal: AbortSignal.any([
                AbortSignal.timeout(1000),
                ...(options.signal ? [options.signal] : []),
              ]),
            }
          : {}),
      })
    const transport =
      record.transport === 'local'
        ? new StdioClientTransport({
            command: record.command,
            args: record.args,
            env: record.env,
            ...(record.cwd ? { cwd: record.cwd } : {}),
            stderr: 'ignore',
          })
        : record.transport === 'sse'
          ? new SSEClientTransport(new URL(record.url), {
              requestInit: { headers: record.headers },
              fetch: remoteFetch,
            })
          : new StreamableHTTPClientTransport(new URL(record.url), {
              requestInit: { headers: record.headers },
              fetch: remoteFetch,
            })
    let closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        if (transport instanceof StreamableHTTPClientTransport && transport.sessionId)
          await transport.terminateSession().catch(() => {})
        await client.close().catch(() => {})
        await transport.close().catch(() => {})
      })())
    const connection: Connection = {
      client,
      transport,
      controller,
      release: [],
      closed: false,
      close,
    }
    entry.connection = connection
    const abort = () => {
      void close()
    }
    controller.signal.addEventListener('abort', abort, { once: true })
    client.onerror = () => {
      /* SDK 错误可能包含请求头或服务器返回值，不记录原文。 */
    }
    client.onclose = () => {
      if (connection.closed || this.closing) return
      void this.lock(async () => {
        if (entry.connection !== connection) return
        await this.disconnect(entry)
        entry.status = 'error'
        entry.error = '连接已断开，请检查服务器后重新连接。'
      }).catch(() => {})
    }
    // 连接建立（包括 HTTP 握手）也必须受超时与插件卸载控制。
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      await client.connect(transport, { signal: controller.signal, timeout: 15000 })
      await this.refreshTools(entry, connection)
      controller.signal.throwIfAborted()
      entry.status = 'connected'
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        void this.lock(async () => {
          if (entry.connection !== connection) return
          try {
            await this.refreshTools(entry, connection)
          } catch {
            await this.disconnect(entry)
            entry.status = 'error'
            entry.error = '工具列表更新失败，请检查服务器后重新连接。'
          }
        }).catch(() => {})
      })
    } catch {
      await this.disconnect(entry)
      entry.status = 'error'
      entry.error = '连接或工具加载失败，请检查地址、命令、凭据和工具定义后重新连接。'
    } finally {
      clearTimeout(timer)
    }
  }
  private async refreshTools(entry: Entry, connection: Connection) {
    const { tools } = await connection.client.listTools(undefined, {
      signal: connection.controller.signal,
      timeout: 15000,
    })
    connection.controller.signal.throwIfAborted()
    const names = new Set<string>()
    const definitions: Tool[] = tools.map((tool) => {
      const id = (entry.record.prefixEnabled ? entry.record.prefix : '') + tool.name
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || names.has(id) || id === 'use_skill')
        throw new Error('MCP 工具名称无效、重复或占用保留名称')
      names.add(id)
      const definition: Tool = {
        id,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema as JsonObject,
        resultMode: 'structured',
        execute: async (args, run) => {
          if (connection.closed) throw new Error('MCP 连接已失效')
          run.signal.throwIfAborted()
          try {
            const result = await connection.client.callTool(
              { name: tool.name, arguments: args },
              { signal: AbortSignal.any([run.signal, connection.controller.signal]) },
            )
            return await toolResult(this.ctx, result, run)
          } catch {
            run.signal.throwIfAborted()
            throw new Error('MCP 工具调用失败，请检查服务器状态或调用参数')
          }
        },
      }
      this.ctx.ai.validateTool(definition)
      return definition
    })
    // 全量校验后再替换；注册沿用 AI 核心的覆盖栈，不绕过运行快照。
    const release: (() => Promise<void>)[] = []
    try {
      for (const definition of definitions)
        release.push(this.ctx.ai.registerTool(this.ctx, definition))
    } catch (error) {
      await Promise.all(release.map((dispose) => dispose()))
      throw error
    }
    await Promise.all(connection.release.splice(0).map((dispose) => dispose()))
    connection.release = release
    entry.tools = tools.map((tool, index) => ({
      name: tool.name,
      id: definitions[index]!.id,
      description: tool.description ?? '',
    }))
  }
}
