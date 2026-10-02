import type { Context } from '@antarestra/plugin-sdk'
import { Http } from '@antarestra/http'
import type { JsonObject, RunContext } from '@antarestra/ai'
import { asJson, sourceId, urlValue } from './common.js'
import type { Config } from './common.js'

interface Result {
  title?: string
  link?: string
  snippet?: string
  date?: string
}
export function searchTool(ctx: Context, config: Config) {
  const client: Http = ctx.http.extend({
    baseUrl: 'https://google.serper.dev',
    proxyAgent: config.searchProxy ?? '',
  })
  return async (args: JsonObject, context: RunContext) => {
    const queries = Array.isArray(args.queries) ? (args.queries as string[]) : [String(args.query)]
    const domains = (Array.isArray(args.domains) ? (args.domains as string[]) : []).map((domain) =>
      new URL(`https://${domain}`).hostname.toLowerCase(),
    )
    const started = Date.now()
    const results = await Promise.all(
      queries.map(async (query) => {
        if (!config.apiKey)
          return { query, error: 'missing_api_key', message: '未配置 Serper 密钥' }
        try {
          const q = domains.length
            ? `${query} (${domains.map((domain) => `site:${domain}`).join(' OR ')})`
            : query
          const value = await client.post<{ organic?: Result[] }>(
            '/search',
            {
              q,
              num: args.count ?? 10,
              page: args.page ?? 1,
              ...(args.language ? { hl: args.language } : {}),
              ...(args.country ? { gl: args.country } : {}),
              ...(args.timeRange ? { tbs: `qdr:${args.timeRange}` } : {}),
            },
            {
              headers: { 'X-API-KEY': config.apiKey },
              signal: AbortSignal.any([
                context.signal,
                AbortSignal.timeout(config.timeoutMs ?? 60000),
              ]),
            },
          )
          const items = (value.organic ?? []).flatMap((item) => {
            if (!item.link) return []
            let url: string
            try {
              url = urlValue(item.link)
            } catch {
              return []
            }
            const host = new URL(url).hostname.toLowerCase()
            if (
              domains.length &&
              !domains.some((domain) => host === domain || host.endsWith('.' + domain))
            )
              return []
            return [
              {
                title: item.title ?? url,
                url,
                snippet: item.snippet ?? '',
                date: item.date ?? null,
                sourceId: sourceId(url),
                contentType: 'search_snippet',
              },
            ]
          })
          return { query, items, fetchedAt: new Date().toISOString() }
        } catch (error) {
          context.signal.throwIfAborted()
          const status = Http.Error.is(error) ? error.response?.status : undefined
          return {
            query,
            error:
              status === 401 || status === 403
                ? 'search_auth_failed'
                : status === 429 || status === 402
                  ? 'search_quota'
                  : status
                    ? 'search_upstream_failed'
                    : 'search_network_failed',
            message: status ? `搜索服务返回 HTTP ${status}` : '搜索请求失败或超时，请检查搜索代理',
          }
        }
      }),
    )
    ctx.logger.info(
      '网页搜索完成：请求 %d 次，耗时 %d ms',
      config.apiKey ? queries.length : 0,
      Date.now() - started,
    )
    return { content: asJson({ results }), isError: results.every((result) => 'error' in result) }
  }
}
