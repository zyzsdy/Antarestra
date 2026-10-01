import type { Access, AiService, Bound } from './index.js'
import type {
  ChatMessage,
  ContentBlock,
  JsonObject,
  ModelRef,
  RequestSnapshot,
  RunRecord,
} from '@antarestra/contracts'
import type {
  ExecutionRuntime,
  ModelOutput,
  ResolvedResource,
  RunContext,
  Tool,
  ToolDraft,
} from './types.js'
import { abortable, AiError, canonical, check, compile, freeze, json, template } from './utils.js'
export class Running {
  readonly controller = new AbortController()
  readonly context: RunContext
  sequence = 0
  reply: ContentBlock[] = []
  private tools = new Map<string, Tool>()
  private toolContexts = new WeakSet<RunContext>()
  private systemPrompt = ''
  private transcript: ChatMessage[]
  private pending: Extract<ContentBlock, { type: 'tool-call' }>[] = []
  private callIds = new Set<string>()
  private requesting = false
  private executing = false
  private finishing = false
  private done: Promise<void> = Promise.resolve()
  constructor(
    readonly service: AiService,
    readonly record: RunRecord,
    readonly bound: Bound,
    history: ChatMessage[],
    readonly access: Access,
  ) {
    this.transcript = json(history)
    this.context = Object.freeze({
      runId: record.id,
      conversationId: record.conversationId,
      workspaceId: record.workspaceId,
      actorId: record.actorId,
      agent: freeze(json(record.agent)),
      signal: this.controller.signal,
    })
    for (const [id, registration] of bound.tools) this.tools.set(id, registration.value)
  }
  start() {
    this.done = this.execute()
  }
  ownsToolContext(context: RunContext) {
    return this.toolContexts.has(context) && !context.signal.aborted
  }
  async cancel() {
    if (!this.finishing) this.controller.abort(new AiError('cancelled', '运行已取消'))
    await this.done
  }
  private active() {
    if (this.context.signal.aborted) throw this.context.signal.reason
    check(!this.finishing && this.record.status === 'running', '运行已结束')
    for (const entry of [
      this.bound.agent,
      this.bound.backend,
      ...this.bound.providers.values(),
      ...this.bound.drivers.values(),
      ...this.bound.tools.values(),
      ...this.bound.extensions,
      this.bound.skill,
      this.bound.resources,
    ]) {
      if (entry && !entry.active) {
        this.controller.abort(new AiError('cancelled', '运行依赖已卸载'))
        throw this.context.signal.reason
      }
    }
  }
  validateSelection(ref: ModelRef, thinking: string | null) {
    check(
      this.record.agent.models.some((model) => canonical(model) === canonical(ref)),
      '模型不在 Agent 允许列表',
    )
    const provider = this.bound.providers.get(ref.providerId)?.value
    const model = provider?.models.find((m) => m.id === ref.modelId)
    check(provider && model, '模型不可用')
    check(thinking === null || model.thinkingLevels.includes(thinking), '思考强度不可用')
    return { provider, model, driver: this.bound.drivers.get(provider.driverId)!.value }
  }
  private async hook(name: 'ai/prepare') {
    await abortable(this.service.context.serial(name, this.context), this.context.signal)
    this.active()
  }
  private async execute() {
    try {
      await this.service.persist(this, 'run-start', { status: 'running' })
      this.active()
      await this.hook('ai/prepare')
      if (this.bound.skill) {
        const tool = await abortable(
          this.bound.skill.value.createTool(json(this.record.agent.skillIds), this.context),
          this.context.signal,
        )
        check(tool.id === 'use_skill', 'Skill 服务必须返回 use_skill')
        this.service.validateTool(tool)
        this.tools.set(
          tool.id,
          Object.freeze({ ...tool, parameters: freeze(json(tool.parameters)) }),
        )
      }
      const variables: JsonObject = {
        ...this.record.input.variables,
        input: this.record.input.text,
      }
      const draft = {
        systemPrompt: template(this.record.agent.systemTemplate, variables),
        userPrompt: template(this.record.agent.userTemplate, variables),
      }
      await abortable(
        this.service.context.serial('ai/template', this.context, draft),
        this.context.signal,
      )
      check(
        typeof draft.systemPrompt === 'string' && typeof draft.userPrompt === 'string',
        '模板结果无效',
      )
      this.systemPrompt = draft.systemPrompt
      const message: ChatMessage = {
        role: 'user',
        content: [
          { type: 'text', text: draft.userPrompt },
          ...(this.record.input.attachments ?? []),
        ],
      }
      await this.validateResources(message.content)
      this.record.messages.push(json(message))
      this.transcript.push(json(message))
      await this.service.persist(this, 'message', message)
      const messageSource = this
      const runtime: ExecutionRuntime = {
        context: this.context,
        get messages() {
          return freeze(json(messageSource.transcript))
        },
        request: () => this.request(),
        executeTools: (calls) => this.executeTools(calls),
      }
      await abortable(this.bound.backend.value.run(runtime), this.context.signal)
      this.active()
      check(!this.pending.length && !this.requesting && !this.executing, '后端未完成模型或工具调用')
      check(this.record.messages.at(-1)?.role === 'assistant', '后端未生成最终回复')
      this.finishing = true
      this.record.status = 'completed'
    } catch (error) {
      this.finishing = true
      const cancelled =
        this.controller.signal.aborted &&
        this.controller.signal.reason instanceof AiError &&
        this.controller.signal.reason.code === 'cancelled'
      this.record.status = cancelled ? 'cancelled' : 'failed'
      if (!cancelled)
        this.service.context.logger.error(
          'AI 运行失败（运行 %s，提供商 %s，模型 %s）：%s',
          this.record.id,
          this.record.model.providerId,
          this.record.model.modelId,
          error instanceof AiError ? `${error.code}: ${error.message}` : '未分类异常',
        )
      // 只持久化由本服务或驱动明确处理过的错误文本，不暴露未知异常中的凭据。
      this.record.error = {
        code: error instanceof AiError ? error.code : 'execution_failed',
        message: cancelled
          ? '运行已取消'
          : error instanceof AiError
            ? error.message
            : '运行失败，请检查服务端日志',
      }
      this.controller.abort(error)
    }
    this.record.endedAt = Date.now()
    try {
      await this.service.persist(this, 'run-end', {
        status: this.record.status,
        error: this.record.error,
      })
    } catch (error) {
      this.service.context.logger.error(
        'AI 运行终态持久化失败（运行 %s），将于下次启动标记为中断：%s',
        this.record.id,
        error instanceof Error ? error.name : '未知异常',
      )
    } finally {
      this.service.running.delete(this.record.id)
    }
  }
  private async validateResources(content: ContentBlock[]) {
    for (const block of content) {
      check(block && typeof block === 'object', '消息内容无效')
      if (block.type === 'image' || block.type === 'file') {
        check(
          typeof block.resourceId === 'string' && typeof block.mimeType === 'string',
          '资源引用无效',
        )
        if (!this.bound.resources)
          throw new AiError('capability_unavailable', '附件解析器不可用', 503)
        await abortable(
          this.bound.resources.value.validate(block, this.context),
          this.context.signal,
        )
      } else if (block.type === 'text' || block.type === 'thinking')
        check(typeof block.text === 'string', '文本内容无效')
      else
        check(
          block.type === 'tool-call' ||
            block.type === 'tool-result' ||
            block.type === 'provider-tool',
          '消息内容类型无效',
        )
    }
  }
  private async request(): Promise<ModelOutput> {
    this.active()
    check(
      !this.requesting && !this.executing && !this.pending.length,
      '模型请求必须串行且工具结果完整',
    )
    if (this.record.requests.length >= this.service.config.maxModelCalls)
      throw new AiError('model_call_limit', '模型调用次数达到上限')
    this.requesting = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const local = new AbortController()
    const signal = AbortSignal.any([local.signal, this.context.signal])
    try {
      const draft: RequestSnapshot = {
        model: json(this.record.model),
        thinking: this.record.thinking,
        parameters: {},
        systemPrompt: this.systemPrompt,
        messages: json(this.transcript),
        tools: [...this.tools.values()].map((tool) => ({
          id: tool.id,
          description: tool.description,
          parameters: json(tool.parameters),
        })),
      }
      await abortable(this.service.context.serial('ai/request', this.context, draft), signal)
      await abortable(this.service.context.serial('ai/context', this.context, draft), signal)
      this.active()
      const { provider, model, driver } = this.validateSelection(draft.model, draft.thinking)
      const builtinTools = (provider.builtinTools ?? []).filter(
        (tool) =>
          model.tools &&
          tool.modelIds.includes(model.id) &&
          this.record.agent.toolIds.includes(tool.id),
      )
      check(
        typeof draft.systemPrompt === 'string' &&
          Array.isArray(draft.messages) &&
          Array.isArray(draft.tools),
        '请求草稿无效',
      )
      draft.tools.push(
        ...builtinTools.map((tool) => ({
          id: tool.id,
          description: tool.description,
          parameters: {},
          providerTool: { name: tool.name, type: tool.type, options: json(tool.options) },
        })),
      )
      check(
        draft.tools.every((tool) => {
          if (tool.providerTool)
            return builtinTools.some(
              (original) =>
                original.id === tool.id &&
                canonical(tool.providerTool) ===
                  canonical({
                    name: original.name,
                    type: original.type,
                    options: original.options,
                  }),
            )
          const original = this.tools.get(tool.id)
          return original && canonical(tool.parameters) === canonical(original.parameters)
        }),
        '工具声明不能增加未授权工具或修改参数 Schema',
      )
      check(model.tools || !draft.tools.length, '模型不支持工具')
      for (const message of draft.messages) {
        check(
          ['user', 'assistant', 'tool'].includes(message.role) && Array.isArray(message.content),
          '消息格式无效',
        )
        await this.validateResources(message.content)
        for (const block of message.content)
          if (block.type === 'text' || block.type === 'image' || block.type === 'file')
            check(
              (block.type === 'file' && driver.fileInput) || model.input.includes(block.type),
              '模型不支持输入模态',
            )
      }
      // 完整工具调用与结果必须配对；上下文插件不得留下孤立调用。
      const pending = new Set<string>()
      for (const message of draft.messages)
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            check(!pending.has(block.id), '上下文工具调用重复')
            pending.add(block.id)
          }
          if (block.type === 'tool-result') {
            check(pending.delete(block.id), '上下文工具结果缺少调用')
          }
        }
      check(!pending.size, '上下文工具结果不完整')
      if (driver.parameters) compile(driver.parameters)(draft.parameters)
      else check(Object.keys(draft.parameters).length === 0, '驱动未声明扩展参数')
      if (driver.estimateTokens) {
        const tokens = await abortable(Promise.resolve(driver.estimateTokens(draft)), signal)
        if (tokens > model.contextWindow)
          throw new AiError('context_overflow', '上下文超过模型限制')
      }
      const request = freeze(json(draft))
      this.record.requests.push(json(request))
      await this.service.persist(this, 'request', {
        index: this.record.requests.length,
        model: request.model,
      })
      const touch = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(
          () => local.abort(new AiError('model_idle_timeout', '模型无活动超时')),
          provider.idleTimeoutMs ?? this.service.config.modelIdleTimeoutMs,
        )
      }
      touch()
      const credential = provider.resolveCredential
        ? await abortable(provider.resolveCredential({ ...this.context, signal }), signal)
        : undefined
      const resources = new Map<string, ResolvedResource>()
      let attachmentBytes = 0
      for (const message of request.messages)
        for (const block of message.content)
          if (
            (block.type === 'image' || block.type === 'file') &&
            !resources.has(block.resourceId)
          ) {
            const resolver = this.bound.resources?.value
            if (!resolver?.resolve)
              throw new AiError('capability_unavailable', '附件内容解析器不可用', 503)
            const resource = await abortable(resolver.resolve(block, this.context), signal)
            attachmentBytes += Buffer.byteLength(resource.data, 'base64')
            if (attachmentBytes > 32 * 1024 * 1024)
              throw new AiError(
                'attachment_too_large',
                '本次模型上下文的附件总量超过 32 MiB，请减少附件或新建对话',
              )
            resources.set(block.resourceId, resource)
          }
      const output = await abortable(
        driver.generate(
          request,
          { baseUrl: provider.baseUrl, credential, resources },
          { ...this.context, signal },
          async (update) => {
            this.active()
            signal.throwIfAborted()
            touch()
            if (update.type === 'provider-tool') {
              const block = update.content
              check(
                request.tools.some((tool) => tool.providerTool?.name === block.name),
                '提供商调用了未授权的内置工具',
              )
              const existing = this.record.messages
                .flatMap((message) => message.content)
                .find((item) => item.type === 'provider-tool' && item.id === block.id)
              if (existing) Object.assign(existing, json(block))
              else this.record.messages.push({ role: 'assistant', content: [json(block)] })
              await this.service.persist(this, 'provider-tool', json(block))
            }
            if (update.type === 'delta') {
              check(
                typeof update.text === 'string' && ['text', 'thinking'].includes(update.kind),
                '增量格式无效',
              )
              this.reply.push({ type: update.kind, text: update.text })
              await this.service.persist(this, 'message-delta', update)
            }
          },
        ),
        signal,
      )
      this.active()
      signal.throwIfAborted()
      check(Array.isArray(output.content), '模型响应无效')
      await this.validateResources(output.content)
      // 先保存模型给出的调用，再校验是否允许执行，拒绝的调用也能在历史中查看。
      const message: ChatMessage = { role: 'assistant', content: json(output.content) }
      const hostedIds = new Set(
        output.content.flatMap((block) => (block.type === 'provider-tool' ? [block.id] : [])),
      )
      this.record.messages = this.record.messages
        .map((entry) => ({
          ...entry,
          content: entry.content.filter(
            (block) => block.type !== 'provider-tool' || !hostedIds.has(block.id),
          ),
        }))
        .filter((entry) => entry.content.length > 0)
      this.record.messages.push(message)
      this.reply = this.record.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.content)
      await this.service.persist(this, 'message', { ...message, usage: output.usage ?? null })
      const calls: typeof this.pending = []
      for (const block of output.content) {
        if (block.type === 'provider-tool') {
          check(
            request.tools.some((tool) => tool.providerTool?.name === block.name),
            '提供商调用了未授权的内置工具',
          )
          continue
        }
        if (block.type === 'text' || block.type === 'image' || block.type === 'file')
          check(model.output.includes(block.type), '模型不支持输出模态')
        check(block.type !== 'tool-result', '模型不能生成工具结果')
        if (block.type === 'tool-call') {
          check(
            typeof block.id === 'string' && block.id.length > 0 && !this.callIds.has(block.id),
            '工具调用 ID 重复或无效',
          )
          check(
            request.tools.some((tool) => tool.id === block.name),
            '模型调用了未提供的工具',
          )
          check(
            block.arguments &&
              typeof block.arguments === 'object' &&
              !Array.isArray(block.arguments),
            '工具参数无效',
          )
          this.callIds.add(block.id)
          calls.push(json(block))
        }
      }
      this.transcript.push(json(message))
      this.pending = calls
      return json(output)
    } finally {
      if (timer) clearTimeout(timer)
      local.abort()
      this.requesting = false
    }
  }
  private async executeTools(calls: typeof this.pending): Promise<ChatMessage[]> {
    this.active()
    check(
      !this.requesting &&
        !this.executing &&
        this.pending.length > 0 &&
        canonical(calls) === canonical(this.pending),
      '工具批次必须匹配模型调用',
    )
    this.executing = true
    const batch = new AbortController()
    const resultIndex = this.record.messages.length
    try {
      const results = await Promise.all(
        calls.map(async (call) => {
          const tool = this.tools.get(call.name)!
          const local = new AbortController()
          const signal = AbortSignal.any([this.context.signal, batch.signal, local.signal])
          const context = Object.freeze({ ...this.context, signal })
          const draft: ToolDraft = { call: json(call), blocked: null, result: null, isError: false }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            compile(tool.parameters)(draft.call.arguments)
            await abortable(this.service.context.serial('ai/tool-before', context, draft), signal)
            check(
              draft.call.id === call.id && draft.call.name === call.name,
              '钩子不能更换工具身份',
            )
            compile(tool.parameters)(draft.call.arguments)
            this.active()
            await this.service.persist(this, 'tool-start', draft.call)
            if (draft.blocked !== null) {
              draft.isError = true
              draft.result = { error: draft.blocked }
            } else {
              const timeout =
                tool.timeoutMs === undefined ? this.service.config.toolTimeoutMs : tool.timeoutMs
              if (timeout !== null)
                timer = setTimeout(
                  () => local.abort(new AiError('tool_timeout', '工具执行超时')),
                  timeout,
                )
              try {
                this.toolContexts.add(context)
                draft.result = json(
                  await abortable(
                    Promise.resolve().then(() => tool.execute(json(draft.call.arguments), context)),
                    signal,
                  ),
                )
              } catch {
                this.active()
                batch.signal.throwIfAborted()
                draft.isError = true
                draft.result = { error: local.signal.aborted ? '工具执行超时' : '工具执行失败' }
              }
            }
            if (timer) clearTimeout(timer)
            await abortable(
              this.service.context.serial('ai/tool-after', this.context, draft),
              this.context.signal,
            )
            this.active()
            batch.signal.throwIfAborted()
            const result: ChatMessage = {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  id: call.id,
                  content: json(draft.result),
                  isError: draft.isError,
                },
              ],
            }
            // 单项完成即保存，其他并发工具失败或取消时也保留已返回的详情。
            this.record.messages.push(json(result))
            await this.service.persist(this, 'tool-end', result)
            return result
          } finally {
            this.toolContexts.delete(context)
            if (timer) clearTimeout(timer)
            local.abort()
          }
        }),
      )
      this.active()
      // 完整批次按调用顺序提供上下文；中途失败时保留已经独立保存的结果。
      this.record.messages.splice(resultIndex, results.length, ...json(results))
      this.transcript.push(...json(results))
      this.pending = []
      for (const result of results) await this.service.persist(this, 'message', result)
      return json(results)
    } catch (error) {
      batch.abort(error)
      throw error
    } finally {
      this.executing = false
    }
  }
}
