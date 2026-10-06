import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { AiError } from '@antarestra/ai'
import type { Json, JsonObject, RunContext } from '@antarestra/ai'
import { MemoryService } from './service.js'
import type { Config } from './service.js'
import { migrations, pluginId } from './store.js'
import type { Tables } from './store.js'

export { MemoryService } from './service.js'
export type { Config } from './service.js'
export const inject = ['database', 'ai']
export const name = 'memory'
const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: '已有长期记忆的 id，可从 memory_create 或 memory_search 获取。',
}
const revision = {
  type: 'integer',
  minimum: 0,
  description: '最近读取结果中的 revision；若报告修订冲突，重新读取并核对内容后再操作。',
}
const text = { type: 'string' }
export async function apply(ctx: Context, input: Partial<Config> = {}) {
  const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  const db = await ctx.database.postgres<Tables>(ctx, pluginId, config.postgresUrl)
  await db.migrate(migrations)
  ctx.fiber.assertActive()
  await ctx.plugin(MemoryService, { config, db })
  await ctx.plugin({ inject: ['memory', 'ai'], apply: registerTools })
}

function registerTools(ctx: Context) {
  const memory = ctx.memory
  ctx.ai.registerTemplateVariable(ctx, {
    id: 'global_memory',
    description: '当前工作空间的全局记忆内容，由记忆插件提供；尚未保存记忆时为空文本。',
    resolve: async (context) => (await memory.global(context)).content,
  })
  const register = (
    id: string,
    description: string,
    properties: JsonObject,
    required: string[],
    execute: (args: JsonObject, context: RunContext) => Promise<unknown>,
  ) => {
    ctx.ai.registerTool(ctx, {
      id,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      resultMode: 'structured',
      // 自动整理遵循模型无活动超时与运行取消，不受默认工具短超时截断。
      ...(id === 'global_memory' ? { timeoutMs: null } : {}),
      async execute(args, context) {
        try {
          await ctx.ai.authorizeRunContext(context, true)
          return { content: (await execute(args, context)) as Json }
        } catch (error) {
          context.signal.throwIfAborted()
          return {
            isError: true,
            content: {
              code: error instanceof AiError ? error.code : 'memory_unavailable',
              error:
                error instanceof AiError
                  ? error.message
                  : '记忆操作失败，请检查数据库服务或稍后重试',
            },
          }
        }
      },
    })
  }
  register(
    'global_memory',
    '维护当前工作空间跨会话共享的简短记忆，适合稳定偏好和重要事实；详细资料用 memory_create 保存。get 读取正文、容量预算和 revision；append 追加 content；set 用 content 替换全文；clear 清空。set 和 clear 须先 get，再将 revision 传入 expectedRevision。内容超出预算时可能被压缩或删减，操作后检查返回的最终正文。',
    {
      action: {
        type: 'string',
        enum: ['get', 'set', 'append', 'clear'],
        description:
          'get 不带其他参数；append 仅带 content；set 带 content 和 expectedRevision；clear 仅带 expectedRevision。',
      },
      content: { ...text, description: 'set 时为完整替换正文；append 时为新增正文。' },
      expectedRevision: revision,
    },
    ['action'],
    async (args, context) => {
      const action = args.action as 'get' | 'set' | 'append' | 'clear'
      if ((action === 'set' || action === 'append') && typeof args.content !== 'string')
        throw new AiError('invalid_memory', '写入需要 content')
      if ((action === 'get' || action === 'clear') && args.content !== undefined)
        throw new AiError('invalid_memory', '读取或清空不需要 content')
      if ((action === 'get' || action === 'append') && args.expectedRevision !== undefined)
        throw new AiError('invalid_memory', '读取或追加不需要修订号')
      return memory.global(
        context,
        action,
        args.content as string | undefined,
        args.expectedRevision as number | undefined,
      )
    },
  )
  register(
    'memory_create',
    '保存值得跨会话保留的详细资料、经验或事实，创建当前工作空间的长期记忆。先用 memory_search 检查是否已有同主题记忆，需要修订已有内容时用 memory_update。正文应包含足够背景，便于以后独立理解。返回 id 和 revision，并关联当前会话。',
    {
      content: {
        ...text,
        minLength: 1,
        description: '要保存的完整正文，包含主题、必要背景和可复用信息。',
      },
    },
    ['content'],
    (args, context) => memory.create(context, String(args.content)),
  )
  register(
    'memory_read',
    '按 id 读取当前工作空间的长期记忆，返回正文、revision 和关联会话，并关联当前会话。正文按字符分页；nextOffset 非空时将其作为 offset 继续读取，直到为 null 才表示读完。更新全文前必须读完所有页。',
    {
      id: identifier,
      offset: {
        type: 'integer',
        minimum: 0,
        description: '起始字符位置，从 0 开始，默认 0；续读使用返回的 nextOffset。',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 64000,
        description: '本次最多读取的 Unicode 字符数，默认 16000。',
      },
    },
    ['id'],
    (args, context) =>
      memory.read(
        context,
        String(args.id),
        args.offset as number | undefined,
        args.limit as number | undefined,
      ),
  )
  register(
    'memory_update',
    '修订已有长期记忆，用 content 替换整篇正文。先用 memory_read 读完所有页，保留仍有效的内容，并将读取的 revision 传入 expectedRevision。修订冲突时重新读取、合并修改后再提交。成功后返回新 revision，并关联当前会话。',
    {
      id: identifier,
      content: { ...text, minLength: 1, description: '修改后的完整正文，不是追加片段或差异。' },
      expectedRevision: revision,
    },
    ['id', 'content', 'expectedRevision'],
    (args, context) =>
      memory.update(context, String(args.id), String(args.content), Number(args.expectedRevision)),
  )
  register(
    'memory_forget',
    '永久删除当前工作空间中的一篇长期记忆及其所有会话关联，之后无法再搜索或读取。先用 memory_read 确认目标，并将 revision 传入 expectedRevision。仅在整篇资料应被遗忘时使用；只需解除某个会话的关联时用 memory_link remove。',
    {
      id: identifier,
      expectedRevision: revision,
    },
    ['id', 'expectedRevision'],
    (args, context) => memory.forget(context, String(args.id), Number(args.expectedRevision)),
  )
  register(
    'memory_search',
    '查找当前工作空间中已保存的长期记忆。支持中英文关键词，多个词须全部匹配；结果过少时减少关键词。返回 id 和正文片段，完整内容用 memory_read 获取。省略 query 或传空字符串可列出最近更新的记忆；conversationId 筛选与指定会话关联的记忆。将非空 nextOffset 作为 offset 继续翻页。搜索不会关联当前会话。',
    {
      query: {
        type: 'string',
        maxLength: 4096,
        description: '搜索关键词；省略或留空列出最近更新的记忆。',
      },
      mode: {
        type: 'string',
        enum: ['text', 'vector'],
        description: '省略或填 text；vector 当前不可用。',
      },
      conversationId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: '仅查找与此会话关联的记忆；省略则搜索整个当前工作空间。',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: '跳过的结果条数，默认 0；翻页使用返回的 nextOffset。',
      },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页结果数，默认 20。' },
    },
    [],
    (args, context) => memory.search(context, args as Parameters<MemoryService['search']>[1]),
  )
  register(
    'memory_link',
    '将长期记忆关联到指定会话，或解除关联。add 的目标须为当前工作空间中已有会话；remove 只解除关联，保留记忆正文，仍可在工作空间内搜索。不改变记忆最初的创建会话；以后在某会话中读取或修改记忆，会再次关联该会话。',
    {
      id: identifier,
      conversationId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: '要添加或解除关联的会话 id。',
      },
      action: {
        type: 'string',
        enum: ['add', 'remove'],
        description: 'add 添加关联；remove 解除关联。',
      },
    },
    ['id', 'conversationId', 'action'],
    (args, context) =>
      memory.link(
        context,
        String(args.id),
        String(args.conversationId),
        args.action as 'add' | 'remove',
      ),
  )
}
