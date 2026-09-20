import type { Context } from '@antarestra/plugin-sdk'
import type { ExecutionBackend } from '@antarestra/ai'
import { runAgentLoop, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai'

export const name = 'ai-agent-core'
export const inject = ['ai']

// 仅满足 pi 循环的类型协议。真正的模型、上下文和凭据由 runtime.request 解析。
const bridgeModel: Model<Api> = {
  id: 'ai-runtime',
  name: 'AI 受控运行接口',
  api: 'openai-completions',
  provider: 'antarestra',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  contextWindow: 0,
  maxTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function message(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: bridgeModel.api,
    provider: bridgeModel.provider,
    model: bridgeModel.id,
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

export const backend: ExecutionBackend = {
  id: 'ai-agent-core',
  async run(runtime) {
    const signal = runtime.context.signal
    const tools: AgentTool[] = []
    let failure: { error: unknown } | undefined
    signal.throwIfAborted()
    await runAgentLoop(
      [],
      { systemPrompt: '', messages: [], tools },
      {
        model: bridgeModel,
        // pi 的消息只用于推进循环，完整历史和请求转换始终由 AI 核心维护。
        convertToLlm: () => [],
        toolExecution: 'parallel',
        afterToolCall: async ({ result }) => ({ isError: result.details === true }),
      },
      () => {
        signal.throwIfAborted()
        // pi 会将工具异常转换成结果；核心异常必须终止运行并保留原始错误码。
        if (failure) throw failure.error
      },
      signal,
      async () => {
        const stream = createAssistantMessageEventStream()
        const reply = message()
        try {
          signal.throwIfAborted()
          const output = await runtime.request()
          signal.throwIfAborted()
          const calls = output.content.filter((block) => block.type === 'tool-call')
          let batch: ReturnType<typeof runtime.executeTools> | undefined
          tools.length = 0
          for (const toolName of new Set(calls.map((call) => call.name))) {
            tools.push({
              name: toolName,
              label: toolName,
              description: '',
              // 此处不重复校验或转换参数，原始批次由核心按真实 Schema 校验。
              parameters: Type.Object({}, { additionalProperties: true }),
              async execute(id) {
                try {
                  signal.throwIfAborted()
                  batch ??= runtime.executeTools(calls)
                  const messages = await batch
                  signal.throwIfAborted()
                  const result = messages
                    .flatMap((entry) => entry.content)
                    .find((block) => block.type === 'tool-result' && block.id === id)
                  if (!result || result.type !== 'tool-result')
                    throw new Error('AI 核心未返回完整工具结果')
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result.content) }],
                    details: result.isError,
                  }
                } catch (error) {
                  failure ??= { error }
                  throw error
                }
              },
            })
          }
          for (const block of output.content) {
            if (block.type === 'text') reply.content.push({ type: 'text', text: block.text })
            if (block.type === 'thinking')
              reply.content.push({ type: 'thinking', thinking: block.text })
            if (block.type === 'tool-call')
              reply.content.push({
                type: 'toolCall',
                id: block.id,
                name: block.name,
                arguments: block.arguments,
              })
          }
          reply.stopReason = calls.length ? 'toolUse' : 'stop'
          stream.push({ type: 'done', reason: reply.stopReason, message: reply })
        } catch (error) {
          failure ??= { error }
          reply.stopReason = signal.aborted ? 'aborted' : 'error'
          reply.errorMessage = 'AI 受控请求失败'
          stream.push({ type: 'error', reason: reply.stopReason, error: reply })
        }
        stream.end(reply)
        return stream
      },
    )
    signal.throwIfAborted()
    if (failure) throw failure.error
  },
}

export function apply(ctx: Context) {
  ctx.ai.registerBackend(ctx, backend)
}
