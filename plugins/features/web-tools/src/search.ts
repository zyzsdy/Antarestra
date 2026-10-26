import type { Context } from '@antarestra/plugin-sdk'
import { Http } from '@antarestra/http'
import type { JsonObject, RunContext } from '@antarestra/ai'
import { asJson, sourceId, urlValue } from './common.js'
import type { Config } from './common.js'

type Source = 'google search' | 'deepseek'
interface Result {
  title?: string
  link?: string
  url?: string
  snippet?: string
  summary?: string
  date?: string | null
}
export function searchTool(ctx: Context, config: Config) {
  const serper: Http = ctx.http.extend({
    baseUrl: 'https://google.serper.dev',
    proxyAgent: config.searchProxy ?? '',
  })
  const deepseek: Http = ctx.http.extend({
    baseUrl: 'https://api.deepseek.com',
    proxyAgent: config.searchProxy ?? '',
  })
  return async (args: JsonObject, context: RunContext) => {
    context.signal.throwIfAborted()
    const queries = Array.isArray(args.queries) ? (args.queries as string[]) : [String(args.query)]
    const domains = (Array.isArray(args.domains) ? (args.domains as string[]) : []).map((domain) =>
      new URL(`https://${domain}`).hostname.toLowerCase(),
    )
    const sources: Source[] = []
    if (config.serperEnabled ?? true) sources.push('google search')
    if (config.deepseekEnabled ?? false) sources.push('deepseek')
    const started = Date.now()
    let requests = 0
    const results = await Promise.all(
      queries.map(async (query) => {
        if (!sources.length)
          return { query, error: 'search_disabled', message: '未启用任何搜索服务' }
        const providers = await Promise.all(
          sources.map(async (source) => {
            const isDeepseek = source === 'deepseek'
            const key = isDeepseek ? config.deepseekApiKey : config.apiKey
            if (!key)
              return {
                source,
                error: 'missing_api_key',
                message: `未配置 ${isDeepseek ? 'DeepSeek' : 'Serper'} 密钥`,
              }
            try {
              let q = domains.length
                ? `${query} (${domains.map((domain) => `site:${domain}`).join(' OR ')})`
                : query
              const warnings: string[] = []
              if (isDeepseek) {
                if (args.language) q += ` lang:${args.language}`
                if ([...q].length > 128 || !q.trim())
                  return {
                    source,
                    error: 'invalid_query',
                    message: 'DeepSeek 搜索词（含筛选语法）须为 1～128 个 Unicode 字符',
                  }
                if (args.page && args.page !== 1) warnings.push('DeepSeek 不支持分页，返回首页结果')
                if (args.country) warnings.push('DeepSeek 不支持 country，本来源未应用地区筛选')
                if (args.timeRange)
                  warnings.push(
                    'DeepSeek 不支持 timeRange，本来源未应用时间筛选；可在 query 中使用 after:/before:',
                  )
              }
              const options = {
                headers: isDeepseek ? { Authorization: `Bearer ${key}` } : { 'X-API-KEY': key },
                signal: AbortSignal.any([
                  context.signal,
                  AbortSignal.timeout(config.timeoutMs ?? 60000),
                ]),
              }
              requests++
              const rows = isDeepseek
                ? (
                    await deepseek.post<{ results: Result[] }>(
                      '/v1/tools/search',
                      {
                        query: q,
                        count: args.count ?? 10,
                        need_content: false,
                      },
                      options,
                    )
                  ).results
                : ((
                    await serper.post<{ organic?: Result[] }>(
                      '/search',
                      {
                        q,
                        num: args.count ?? 10,
                        page: args.page ?? 1,
                        ...(args.language ? { hl: args.language } : {}),
                        ...(args.country ? { gl: args.country } : {}),
                        ...(args.timeRange ? { tbs: `qdr:${args.timeRange}` } : {}),
                      },
                      options,
                    )
                  ).organic ?? [])
              const items = rows.flatMap((item) => {
                const link = isDeepseek ? item.url : item.link
                if (!link) return []
                let url: string
                try {
                  url = urlValue(link)
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
                    ...(isDeepseek ? { summary: item.summary ?? item.snippet ?? '' } : {}),
                    date: item.date ?? null,
                    source,
                    sourceId: sourceId(url),
                    contentType: 'search_snippet',
                  },
                ]
              })
              return { source, items, warnings }
            } catch (error) {
              context.signal.throwIfAborted()
              const status = Http.Error.is(error) ? error.response?.status : undefined
              return {
                source,
                error:
                  status === 401 || status === 403
                    ? 'search_auth_failed'
                    : status === 429 || status === 402
                      ? 'search_quota'
                      : status
                        ? 'search_upstream_failed'
                        : 'search_network_failed',
                message: status
                  ? `搜索服务返回 HTTP ${status}`
                  : '搜索请求失败或超时，请检查搜索代理',
              }
            }
          }),
        )
        const errors = providers.filter((provider) => 'error' in provider)
        return {
          query,
          items: providers.flatMap((provider) => provider.items ?? []),
          errors,
          warnings: providers.flatMap((provider) =>
            (provider.warnings ?? []).map((message) => ({ source: provider.source, message })),
          ),
          fetchedAt: new Date().toISOString(),
          ...(errors.length === providers.length ? { error: 'search_failed' } : {}),
        }
      }),
    )
    ctx.logger.info('网页搜索完成：请求 %d 次，耗时 %d ms', requests, Date.now() - started)
    return { content: asJson({ results }), isError: results.every((result) => 'error' in result) }
  }
}
