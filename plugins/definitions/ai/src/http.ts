import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@antarestra/plugin-sdk'
import type { HttpContext } from '@antarestra/plugin-server'
import { AuthError, readJson } from '@antarestra/rbac'
import type { RunCommand } from '@antarestra/contracts'
import type { Access } from './index.js'
import { AiError, check, identifier } from './utils.js'
export function routes(ctx: Context) {
  const route = (
    method: string,
    path: string,
    handler: (http: HttpContext, access: Access) => Promise<void>,
  ) => {
    ctx.server.route(ctx, method, '/ai' + path, async (http) => {
      http.set('Cache-Control', 'no-store')
      try {
        const access = await ctx.ai.authorize('web', http)
        if (http.query.workspaceId !== undefined && http.query.workspaceId !== access.workspaceId)
          throw new AiError('forbidden', '不能访问其他空间', 403)
        await handler(http, access)
      } catch (error) {
        if (error instanceof AiError || error instanceof AuthError) {
          http.status = error.status
          http.body = {
            error: {
              code:
                error instanceof AiError
                  ? error.code
                  : error.status === 401
                    ? 'unauthenticated'
                    : 'forbidden',
              message: error.message,
            },
          }
        } else {
          http.status = 500
          http.body = { error: { code: 'internal_error', message: 'AI 服务处理失败' } }
        }
      }
    })
  }
  const id = (http: HttpContext) => {
    const value = http.params.id
    identifier(value)
    return value
  }
  route('GET', '/catalog', async (http, access) => {
    http.body = await ctx.ai.catalog(access)
  })
  route('GET', '/conversations', async (http, access) => {
    http.body = await ctx.ai.listConversations(
      access,
      Number(http.query.offset ?? 0),
      Number(http.query.limit ?? 50),
    )
  })
  route('POST', '/conversations', async (http, access) => {
    const body = await readJson(http)
    if (body.agentId !== undefined) identifier(body.agentId)
    check(body.title === undefined || typeof body.title === 'string', '标题无效')
    http.body = await ctx.ai.createConversation(access, body.agentId, body.title)
    http.status = 201
  })
  route('GET', '/conversations/:id', async (http, access) => {
    http.body = await ctx.ai.getConversation(access, id(http))
  })
  route('PATCH', '/conversations/:id/selection', async (http, access) => {
    const body = await readJson(http)
    check(
      typeof body.expectedRevision === 'number' && Number.isSafeInteger(body.expectedRevision),
      '修订号无效',
    )
    check(body.expectedNodeId === null || typeof body.expectedNodeId === 'string', '预期节点无效')
    check(body.nodeId === null || typeof body.nodeId === 'string', '目标节点无效')
    http.body = await ctx.ai.select(
      access,
      id(http),
      body.expectedRevision,
      body.expectedNodeId,
      body.nodeId,
    )
  })
  route('POST', '/conversations/:id/runs', async (http, access) => {
    const body = await readJson(http, 1_048_576)
    check(
      typeof body.expectedRevision === 'number' && Number.isSafeInteger(body.expectedRevision),
      '修订号无效',
    )
    check(body.expectedNodeId === null || typeof body.expectedNodeId === 'string', '预期节点无效')
    identifier(body.idempotencyKey)
    http.body = await ctx.ai.start(access, id(http), body as unknown as RunCommand)
    http.status = 202
  })
  route('GET', '/runs/:id', async (http, access) => {
    http.body = await ctx.ai.getRun(access, id(http))
  })
  route('POST', '/runs/:id/cancel', async (http, access) => {
    await readJson(http)
    http.body = await ctx.ai.cancel(access, id(http))
  })
  route('GET', '/runs/:id/events', async (http, access) => {
    const runId = id(http)
    await ctx.ai.getRun(access, runId)
    let after = Number(http.get('last-event-id') || http.query.after || 0)
    check(Number.isSafeInteger(after) && after >= 0, '事件游标无效')
    const controller = new AbortController()
    const release = ctx.effect(() => () => {
      controller.abort()
    })
    const close = () => {
      controller.abort()
      void release()
    }
    http.res.once('close', close)
    http.type = 'text/event-stream'
    http.set('X-Accel-Buffering', 'no')
    http.body = Readable.from(
      (async function* () {
        try {
          yield ': connected\n\n'
          while (!controller.signal.aborted) {
            // 从同一持久游标连续读取，无内存事件队列，也不存在重放/实时切换窗口。
            const events = await ctx.ai.events(access, runId, after)
            for (const event of events) {
              after = event.sequence
              yield `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            }
            if (events.at(-1)?.type === 'run-end') return
            if (!events.length) {
              const run = await ctx.ai.getRun(access, runId)
              if (run.status !== 'running') {
                // 终态和最终事件在同一事务写入，再读一次处理查询之间的完成竞态。
                const tail = await ctx.ai.events(access, runId, after)
                for (const event of tail) {
                  after = event.sequence
                  yield `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
                }
                if (!tail.length || tail.at(-1)?.type === 'run-end') return
                continue
              }
              yield ': heartbeat\n\n'
              await delay(250, undefined, { signal: controller.signal })
            }
          }
        } catch {
          if (!controller.signal.aborted)
            yield 'event: error\ndata: {"code":"stream_unavailable"}\n\n'
        } finally {
          http.res.off('close', close)
          await release()
        }
      })(),
      { highWaterMark: 1, objectMode: false },
    )
  })
}
