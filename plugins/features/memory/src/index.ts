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
const identifier = { type: 'string', minLength: 1, maxLength: 200 }
const revision = { type: 'integer', minimum: 0 }
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
    '读写当前工作空间共享的全局记忆。get 读取文本、预算和修订号；set 替换或 clear 清空必须先读取并传 expectedRevision；append 追加。超预算会自动整理并遗忘低价值内容，始终检查返回的最终正文。全局记忆适合稳定偏好和重要事实，详细资料请用长期记忆。',
    {
      action: { type: 'string', enum: ['get', 'set', 'append', 'clear'] },
      content: text,
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
    '创建当前工作空间的长期记忆文档，记录完整文本。自动关联当前会话，返回记忆 ID 和修订号。',
    { content: { ...text, minLength: 1 } },
    ['content'],
    (args, context) => memory.create(context, String(args.content)),
  )
  register(
    'memory_read',
    '按 ID 读取长期记忆正文和会话关联，自动关联当前会话。正文按 Unicode 字符分页，必须继续读取 nextOffset 才能获得长文全部内容。',
    {
      id: identifier,
      offset: revision,
      limit: { type: 'integer', minimum: 1, maximum: 64000 },
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
    '替换长期记忆全文；先完整读取文档并传 expectedRevision，避免覆盖并发修改。自动关联当前会话。',
    {
      id: identifier,
      content: { ...text, minLength: 1 },
      expectedRevision: revision,
    },
    ['id', 'content', 'expectedRevision'],
    (args, context) =>
      memory.update(context, String(args.id), String(args.content), Number(args.expectedRevision)),
  )
  register(
    'memory_forget',
    '永久删除指定长期记忆、搜索索引和会话关联。先读取并传 expectedRevision；仅在资料应被遗忘时调用。',
    {
      id: identifier,
      expectedRevision: revision,
    },
    ['id', 'expectedRevision'],
    (args, context) => memory.forget(context, String(args.id), Number(args.expectedRevision)),
  )
  register(
    'memory_search',
    '召回当前工作空间长期记忆。中英文关键词全部匹配，返回摘要和 ID；用 memory_read 读取正文。空 query 列出最近记忆，支持 conversationId 和分页。搜索列表不会自动关联当前会话。向量模式尚未实现。',
    {
      query: { type: 'string', maxLength: 4096 },
      mode: { type: 'string', enum: ['text', 'vector'] },
      conversationId: identifier,
      offset: revision,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    [],
    (args, context) => memory.search(context, args as Parameters<MemoryService['search']>[1]),
  )
  register(
    'memory_link',
    '为长期记忆添加或移除会话关联。添加只允许同一工作空间现存会话，不改变创建会话记录。读取或修改会再次自动关联当前会话。',
    {
      id: identifier,
      conversationId: identifier,
      action: { type: 'string', enum: ['add', 'remove'] },
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
