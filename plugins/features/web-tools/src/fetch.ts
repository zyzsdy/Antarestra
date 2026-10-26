import type { Context } from '@antarestra/plugin-sdk'
import { Http } from '@antarestra/http'
import type { JsonObject, RunContext, StructuredToolResult } from '@antarestra/ai'
import { errorResult, sourceId, urlValue, WebError } from './common.js'
import type { Config } from './common.js'

export function fetchTool(ctx: Context, config: Config) {
  const client: Http = ctx.http.extend({
    baseUrl: 'https://api.deepseek.com',
    proxyAgent: config.searchProxy ?? '',
  })
  return async (args: JsonObject, context: RunContext): Promise<StructuredToolResult> => {
    try {
      context.signal.throwIfAborted()
      const url = urlValue(args.url)
      if (url.length > 8192) throw new WebError('invalid_url', '网页地址不能超过 8192 个字符')
      if (!config.deepseekApiKey) throw new WebError('missing_api_key', '未配置 DeepSeek 密钥')
      const page = await client.post<{ title: string; content: string }>(
        '/v1/tools/fetch',
        { url },
        {
          headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(config.timeoutMs ?? 60000)]),
        },
      )
      if (
        typeof page.title !== 'string' ||
        typeof page.content !== 'string' ||
        !page.content.trim()
      )
        throw new WebError('fetch_empty_content', 'DeepSeek 未返回可读取的网页正文')
      const offset = typeof args.offset === 'number' ? args.offset : 0
      const limit = Math.min(
        typeof args.maxCharacters === 'number'
          ? args.maxCharacters
          : (config.maxCharacters ?? 24000),
        config.maxCharacters ?? 24000,
      )
      const content = page.content.slice(offset, offset + limit)
      const truncated = offset + content.length < page.content.length
      return {
        content: {
          url,
          title: page.title,
          content,
          source: 'deepseek',
          sourceId: sourceId(url),
          contentType: 'text/markdown',
          fetchedAt: new Date().toISOString(),
          offset,
          totalCharacters: page.content.length,
          truncated,
          nextOffset: truncated ? offset + content.length : null,
        },
      }
    } catch (error) {
      context.signal.throwIfAborted()
      if (error instanceof WebError) return errorResult(error)
      const status = Http.Error.is(error) ? error.response?.status : undefined
      return {
        isError: true,
        content: {
          source: 'deepseek',
          error: status ? 'fetch_upstream_failed' : 'fetch_network_failed',
          message: status
            ? `DeepSeek 网页抓取返回 HTTP ${status}`
            : '网页抓取失败或超时，请检查搜索代理',
        },
      }
    }
  }
}
