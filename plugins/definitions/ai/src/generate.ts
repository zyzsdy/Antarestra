import type { Context } from '@antarestra/plugin-sdk'
import type { Access } from './index.js'
import type { GenerateOptions, ModelDriver, Provider, Registration } from './types.js'
import { abortable, AiError, check, compile, freeze, json } from './utils.js'

/** 直接模型请求不运行模板、扩展、工具或 Agent 循环。 */
export async function generate(
  owner: Context,
  access: Access,
  options: GenerateOptions,
  providerEntry: Registration<Provider>,
  driverEntry: Registration<ModelDriver>,
  signal: AbortSignal,
  idleTimeoutMs: number,
) {
  const provider = providerEntry.value
  const driver = driverEntry.value
  const model = provider.models.find((model) => model.id === options.model.modelId)
  check(model, '模型未注册')
  check(model.input.includes('text') && model.output.includes('text'), '模型不支持文本生成')
  if (driver.parameters) compile(driver.parameters)(options.parameters ?? {})
  else check(Object.keys(options.parameters ?? {}).length === 0, '驱动未声明扩展参数')
  check(
    options.thinking == null || model.thinkingLevels.includes(options.thinking),
    '思考强度不受支持',
  )
  const maxOutputTokens = options.maxOutputTokens ?? model.maxOutputTokens
  check(
    Number.isInteger(maxOutputTokens) &&
      maxOutputTokens > 0 &&
      maxOutputTokens <= model.maxOutputTokens,
    '输出 token 上限无效',
  )
  check(typeof options.systemPrompt === 'string' && Array.isArray(options.messages), '模型输入无效')
  check(
    options.messages.every(
      (message) =>
        ['user', 'assistant'].includes(message.role) &&
        Array.isArray(message.content) &&
        message.content.every((block) => block.type === 'text' && typeof block.text === 'string'),
    ),
    '直接调用仅接受用户和助理的文本上下文',
  )
  const request = freeze(
    json({
      model: options.model,
      thinking: options.thinking ?? null,
      maxOutputTokens,
      parameters: options.parameters ?? {},
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      tools: [],
    }),
  )
  const local = new AbortController()
  const combined = AbortSignal.any([
    signal,
    local.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  const context = Object.freeze({ ...access, signal: combined })
  let timer: ReturnType<typeof setTimeout> | undefined
  const active = () => {
    combined.throwIfAborted()
    owner.fiber.assertActive()
    check(providerEntry.active && driverEntry.active, '模型能力已卸载')
  }
  const touch = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(
      () => local.abort(new AiError('model_idle_timeout', '模型无活动超时')),
      provider.idleTimeoutMs ?? idleTimeoutMs,
    )
  }
  try {
    active()
    touch()
    const credential = provider.resolveCredential
      ? await abortable(provider.resolveCredential(context), combined)
      : undefined
    active()
    const result = await abortable(
      driver.generate(
        request,
        { baseUrl: provider.baseUrl, credential },
        context,
        async (event) => {
          active()
          touch()
          await options.update?.(event)
        },
      ),
      combined,
    )
    active()
    if (result.stopReason && result.stopReason !== 'stop')
      throw new AiError(
        result.stopReason === 'length' ? 'model_output_truncated' : 'model_output_incomplete',
        '模型未完整结束生成',
      )
    check(
      result.content.every((block) => ['text', 'thinking'].includes(block.type)),
      '直接模型调用返回了非文本内容',
    )
    return json(result)
  } finally {
    if (timer) clearTimeout(timer)
    local.abort()
  }
}
