import { lazyApi, normalizeContext, Type } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Message,
  Usage,
  ProviderStreams,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import type { ModelDefinition, ModelDriver, RequestSnapshot, JsonObject } from '@antarestra/ai'
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
function messages(request: RequestSnapshot, model: Model<Api>): Message[] {
  const result: Message[] = []
  const toolNames = new Map<string, string>()
  for (const message of request.messages) {
    if (message.content.some((block) => block.type === 'image' || block.type === 'file'))
      throw new Error('当前模型驱动尚未接入附件资源读取，请使用文本消息')
    if (message.role === 'user') {
      result.push({
        role: 'user',
        content: message.content.flatMap((block) =>
          block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [],
        ),
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
            content: [
              {
                type: 'text',
                text:
                  typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              },
            ],
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
  // 内置提供商可能混用多种协议；仅在使用其官方地址时自动选择模型端点。
  // 自定义网关的协议和地址由管理员配置，不能将其凭据发送到内置端点。
  const native = models.some(
    (model) => model.baseUrl.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''),
  )
  return {
    ...(native || builtin?.api === provider.api ? builtin : undefined),
    id: definition.id,
    name: definition.title,
    provider: provider.builtin || provider.id,
    api: native && builtin ? builtin.api : provider.api,
    baseUrl: native && builtin ? builtin.baseUrl : baseUrl,
    reasoning: definition.thinkingLevels.length > 0,
    input: definition.input.filter((input) => input !== 'file'),
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxOutputTokens,
    cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}
export function driver(provider: ProviderRecord): ModelDriver {
  return {
    id: `ai-provider:${provider.id}`,
    async generate(request, connection, context, update) {
      const definition = provider.models.find((model) => model.id === request.model.modelId)
      if (!definition) throw new Error('模型已不可用')
      const model = resolveModel(provider, definition, connection.baseUrl)
      const api = apis[model.api]!()
      // OpenAI 兼容的本地服务可以不鉴权；仅满足 SDK 构造要求，不发送占位凭据。
      const keyless =
        !connection.credential &&
        !provider.builtin &&
        ['openai-completions', 'openai-responses'].includes(provider.api)
      const stream = api.streamSimple(
        model,
        normalizeContext({
          systemPrompt: request.systemPrompt,
          messages: messages(request, model),
          tools: request.tools.map((tool) => ({
            name: tool.id,
            description: tool.description,
            parameters: Type.Unsafe(tool.parameters),
          })),
        }),
        {
          apiKey: keyless ? 'unused' : (connection.credential ?? ''),
          headers: { ...(keyless ? { authorization: null } : {}), ...provider.headers },
          signal: context.signal,
          env: {},
          maxTokens: definition.maxOutputTokens,
          ...(request.thinking ? { reasoning: request.thinking as ThinkingLevel } : {}),
        },
      )
      for await (const event of stream) {
        if (event.type === 'error') throw new Error('模型请求失败，请检查提供商配置或稍后重试')
        await update(
          event.type === 'text_delta' || event.type === 'thinking_delta'
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
        throw new Error('模型请求失败或已取消')
      return {
        content: result.content.map((block) =>
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
        usage: {
          input: result.usage.input,
          output: result.usage.output,
          totalTokens: result.usage.totalTokens,
        },
      }
    },
  }
}
