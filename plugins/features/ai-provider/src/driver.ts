import { lazyApi, normalizeContext, Type } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Message,
  Usage,
  ProviderStreams,
  ThinkingLevel,
  ImagesInputContent,
} from '@earendil-works/pi-ai'
import { AiError, toolResultContent } from '@antarestra/ai'
import type {
  ModelDefinition,
  ModelDriver,
  RequestSnapshot,
  JsonObject,
  ResolvedResource,
  ContentBlock,
} from '@antarestra/ai'
import { orderOutput } from './output-order.js'
import { filePayload } from './attachments.js'
import { nativeFiles } from './native-files.js'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ProviderRecord } from './types.js'
import { builtinModels } from './catalog.js'

const apis: Record<string, () => ProviderStreams> = {
  'openai-completions': () => lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'openai-responses': () => lazyApi(() => import('@earendil-works/pi-ai/api/openai-responses')),
  'anthropic-messages': () => lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages')),
  'google-generative-ai': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/google-generative-ai')),
  'mistral-conversations': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/mistral-conversations')),
  'azure-openai-responses': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/azure-openai-responses')),
  'openai-codex-responses': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/openai-codex-responses')),
  'bedrock-converse-stream': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/bedrock-converse-stream')),
  'google-vertex': () => lazyApi(() => import('@earendil-works/pi-ai/api/google-vertex')),
  'pi-messages': () => lazyApi(() => import('@earendil-works/pi-ai/api/pi-messages')),
}
const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})
function messages(
  request: RequestSnapshot,
  model: Model<Api>,
  resources: ReadonlyMap<string, ResolvedResource>,
  files: ReturnType<typeof filePayload>,
): Message[] {
  const result: Message[] = []
  const toolNames = new Map<string, string>()
  for (const message of request.messages) {
    if (message.role === 'user') {
      result.push({
        role: 'user',
        content: message.content.flatMap<ImagesInputContent>((block) => {
          if (block.type === 'text') return [{ type: 'text', text: block.text }]
          if (block.type !== 'image' && block.type !== 'file') return []
          const resource = resources.get(block.resourceId)
          if (!resource) throw new AiError('attachment_unavailable', '附件内容不可用')
          return block.type === 'image'
            ? [{ type: 'image', data: resource.data, mimeType: resource.mimeType }]
            : [files.placeholder(resource, block.resourceId)]
        }),
        timestamp: Date.now(),
      })
    } else if (message.role === 'assistant') {
      const content: Extract<Message, { role: 'assistant' }>['content'] = []
      for (const block of message.content) {
        if (block.type === 'text' || block.type === 'thinking') {
          const continuation = block.continuation
          const signature =
            continuation?.model.providerId === request.model.providerId &&
            continuation.model.modelId === request.model.modelId &&
            continuation.driverId === `ai-provider:${request.model.providerId}`
              ? continuation.signature
              : undefined
          if (block.type === 'text')
            content.push({
              type: 'text',
              text: block.text,
              ...(signature ? { textSignature: signature } : {}),
            })
          else
            content.push({
              type: 'thinking',
              thinking: block.text,
              ...(signature ? { thinkingSignature: signature } : {}),
            })
        }
        if (block.type === 'tool-call') {
          toolNames.set(block.id, block.name)
          content.push({
            type: 'toolCall',
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          })
        }
      }
      result.push({
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      })
    } else
      for (const block of message.content) {
        if (block.type === 'tool-result')
          result.push({
            role: 'toolResult',
            toolCallId: block.id,
            toolName: toolNames.get(block.id) ?? 'tool',
            content: toolResultContent(block, resources),
            isError: block.isError,
            timestamp: Date.now(),
          })
      }
  }
  return result
}
export function resolveModel(
  provider: ProviderRecord,
  definition: ModelDefinition,
  baseUrl: string,
): Model<Api> {
  const models = builtinModels(provider.builtin)
  const builtin =
    models.find((model) => model.id === definition.id && model.api === provider.api) ??
    models.find((model) => model.id === definition.id)
  // 远端目录可能早于 pi-ai 发布新模型；同系列端点一致时沿用其请求协议。
  const family = definition.id.split('-')[0]
  const relatives =
    builtin || !provider.models.some((model) => model.id === definition.id)
      ? []
      : models.filter((model) => model.id.startsWith(`${family}-`))
  const endpoints = new Set(relatives.map((model) => `${model.api} ${model.baseUrl}`))
  const related = endpoints.size === 1 ? relatives[0] : undefined
  const match = builtin ?? related
  // 内置提供商可能混用多种协议；仅在使用其官方地址时自动选择模型端点。
  // 自定义网关的协议和地址由管理员配置，不能将其凭据发送到内置端点。
  const native = models.some(
    (model) => model.baseUrl.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''),
  )
  return {
    ...(native || builtin?.api === provider.api ? match : undefined),
    id: definition.id,
    name: definition.title,
    provider: provider.builtin || provider.id,
    api: native && match ? match.api : provider.api,
    baseUrl: native && match ? match.baseUrl : baseUrl,
    reasoning: definition.thinkingLevels.length > 0,
    input: definition.input.filter((input) => input !== 'file'),
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxOutputTokens,
    cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}
export function useBuiltinAdapter(provider: ProviderRecord, modelId: string, baseUrl: string) {
  return (
    provider.models.some((model) => model.id === modelId) && officialBuiltinUrl(provider, baseUrl)
  )
}
function officialBuiltinUrl(provider: ProviderRecord, baseUrl: string) {
  return builtinModels(provider.builtin).some(
    (model) => model.baseUrl.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''),
  )
}
export function driver(provider: ProviderRecord): ModelDriver {
  const adapter = provider.builtin
    ? builtinProviders().find((builtin) => builtin.id === provider.builtin)
    : undefined
  return {
    id: `ai-provider:${provider.id}`,
    fileInput: true,
    async generate(request, connection, context, update) {
      const definition = provider.models.find((model) => model.id === request.model.modelId)
      if (!definition) throw new Error('模型已不可用')
      const model = resolveModel(provider, definition, connection.baseUrl)
      const builtin = adapter && useBuiltinAdapter(provider, definition.id, connection.baseUrl)
      const api = builtin ? adapter : apis[model.api]!()
      // OpenAI 兼容的本地服务可以不鉴权；仅满足 SDK 构造要求，不发送占位凭据。
      const keyless =
        !connection.credential &&
        !provider.builtin &&
        ['openai-completions', 'openai-responses'].includes(provider.api)
      const failure = (message: string) => {
        const safe = message
          .replaceAll(connection.credential || '\0', '[已隐藏]')
          .replace(/https?:\/\/\S+/gi, '[请求地址已隐藏]')
          .replace(/(?:Bearer|api[_-]?key)\s*[:=]?\s*\S+/gi, '[凭据已隐藏]')
          .slice(0, 500)
        return new AiError('provider_request_failed', safe || '模型请求失败')
      }
      const headers = { ...(keyless ? { authorization: null } : {}), ...provider.headers }
      const fileResources = new Map(
        request.messages.flatMap((message) =>
          message.content.flatMap((block) => {
            const resource =
              block.type === 'file' ? connection.resources?.get(block.resourceId) : undefined
            return block.type === 'file' && resource ? [[block.resourceId, resource] as const] : []
          }),
        ),
      )
      const uploaded = await nativeFiles(
        model.api,
        fileResources,
        {
          baseUrl: model.baseUrl,
          credential: connection.credential,
        },
        headers,
        context.signal,
      )
      try {
        const files = filePayload(model.api, uploaded.ids)
        const builtinTools = request.tools.filter((tool) => tool.providerTool)
        if (
          builtinTools.length &&
          !['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(
            model.api,
          )
        )
          throw new AiError('unsupported_builtin_tool', '内置工具需要 OpenAI Responses 接口')
        const hosted = new Map<string, Extract<ContentBlock, { type: 'provider-tool' }>>()
        const outputOrder = new Map<string, number>()
        const stream = api.streamSimple(
          model,
          normalizeContext({
            systemPrompt: request.systemPrompt,
            messages: messages(request, model, connection.resources ?? new Map(), files),
            tools: request.tools
              .filter((tool) => !tool.providerTool)
              .map((tool) => ({
                name: tool.id,
                description: tool.description,
                parameters: Type.Unsafe(tool.parameters),
              })),
          }),
          {
            apiKey: keyless ? 'unused' : (connection.credential ?? ''),
            headers,
            ...(builtin ? { sessionId: context.conversationId } : {}),
            signal: context.signal,
            env: {},
            onPayload: (value: unknown) => {
              const payload = files.transform(value) as Record<string, unknown>
              if (builtinTools.length)
                payload.tools = [
                  ...(Array.isArray(payload.tools) ? payload.tools : []),
                  ...builtinTools.map((tool) => ({
                    ...tool.providerTool!.options,
                    type: tool.providerTool!.type,
                  })),
                ]
              return payload
            },
            onProviderStreamEvent: async (value: unknown) => {
              await update({ type: 'activity' })
              if (!value || typeof value !== 'object') return
              const event = value as Record<string, unknown>
              // 内置工具与文字必须走同一个原始流，避免 pi 队列消费速度改变顺序。
              if (builtinTools.length && typeof event.delta === 'string') {
                const kind =
                  event.type === 'response.output_text.delta' ||
                  event.type === 'response.refusal.delta'
                    ? 'text'
                    : event.type === 'response.reasoning_summary_text.delta' ||
                        event.type === 'response.reasoning_text.delta'
                      ? 'thinking'
                      : null
                if (kind) await update({ type: 'delta', kind, text: event.delta })
              }
              if (builtinTools.length && event.type === 'response.reasoning_summary_part.done')
                await update({ type: 'delta', kind: 'thinking', text: '\n\n' })
              const items =
                event.type === 'response.completed'
                  ? ((event.response as { output?: unknown[] } | undefined)?.output ?? [])
                  : event.type === 'response.output_item.added' ||
                      event.type === 'response.output_item.done'
                    ? [event.item]
                    : []
              for (const [index, value] of items.entries()) {
                if (!value || typeof value !== 'object') continue
                const item = value as JsonObject
                if (typeof item.id === 'string') {
                  const position = event.type === 'response.completed' ? index : event.output_index
                  if (typeof position === 'number') outputOrder.set(item.id, position)
                }
                const tool = builtinTools.find((t) => `${t.providerTool!.type}_call` === item.type)
                if (!tool || typeof item.id !== 'string') continue
                const block: Extract<ContentBlock, { type: 'provider-tool' }> = {
                  type: 'provider-tool',
                  id: item.id,
                  name: tool.providerTool!.name,
                  status: typeof item.status === 'string' ? item.status : 'in_progress',
                  result: item,
                }
                if (JSON.stringify(hosted.get(item.id)) === JSON.stringify(block)) continue
                hosted.set(item.id, block)
                await update({ type: 'provider-tool', content: block })
              }
            },
            maxTokens: request.maxOutputTokens ?? definition.maxOutputTokens,
            ...(request.thinking ? { reasoning: request.thinking as ThinkingLevel } : {}),
          },
        )
        for await (const event of stream) {
          if (event.type === 'error')
            throw failure(event.error.errorMessage ?? '模型请求失败，请检查提供商配置或稍后重试')
          await update(
            !builtinTools.length && (event.type === 'text_delta' || event.type === 'thinking_delta')
              ? {
                  type: 'delta',
                  kind: event.type === 'text_delta' ? 'text' : 'thinking',
                  text: event.delta,
                }
              : { type: 'activity' },
          )
        }
        const result = await stream.result()
        if (result.stopReason === 'error' || result.stopReason === 'aborted')
          throw failure(result.errorMessage ?? '模型请求失败或已取消')
        return {
          content: orderOutput(
            [
              ...hosted.values(),
              ...result.content.map((block) =>
                block.type === 'toolCall'
                  ? {
                      type: 'tool-call' as const,
                      id: block.id,
                      name: block.name,
                      arguments: block.arguments as JsonObject,
                    }
                  : block.type === 'thinking'
                    ? {
                        type: 'thinking' as const,
                        text: block.thinking,
                        ...(block.thinkingSignature
                          ? {
                              continuation: {
                                model: request.model,
                                driverId: `ai-provider:${provider.id}`,
                                signature: block.thinkingSignature,
                              },
                            }
                          : {}),
                      }
                    : {
                        type: 'text' as const,
                        text: block.text,
                        ...(block.textSignature
                          ? {
                              continuation: {
                                model: request.model,
                                driverId: `ai-provider:${provider.id}`,
                                signature: block.textSignature,
                              },
                            }
                          : {}),
                      },
              ),
            ],
            outputOrder,
          ),
          stopReason: result.stopReason,
          usage: {
            input: result.usage.input,
            output: result.usage.output,
            cacheRead: result.usage.cacheRead,
            cacheWrite: result.usage.cacheWrite,
            totalTokens: result.usage.totalTokens,
          },
        }
      } finally {
        await uploaded.dispose()
      }
    },
  }
}
