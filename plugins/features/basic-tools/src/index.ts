import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { AiError } from '@antarestra/ai'
import type { ConversationTodo } from '@antarestra/ai'
import { datetimeTool } from './datetime.js'

const statusSchema = { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
export const inject = ['ai']
export function apply(ctx: Context, config: Record<string, unknown> = {}) {
  schemaConfig(new URL('../config.schema.json', import.meta.url), config)
  ctx.ai.registerTool(ctx, datetimeTool)
  ctx.ai.registerTool(ctx, {
    id: 'rename_conversation',
    description: '修改当前会话标题。使用简洁、准确的标题概括当前话题，一般不要超过20字。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 50 } },
      required: ['title'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const conversation = await ctx.ai.updateRunConversation(context, () => ({
        title: String(args.title),
      }))
      return { title: conversation.title }
    },
  })
  ctx.ai.registerTool(ctx, {
    id: 'todo',
    description:
      '当要处理的事项较为复杂，且可以分步进行时，调用此工具生成待办计划。每轮循环中必须检查计划是否完成，并设置已完成的项目。set 创建或替换完整列表（每项使用稳定且唯一的 id）；update 修改指定项的状态；complete_all 将整个列表标记完成。pending 为待完成，in_progress 为正在进行，completed 为已完成。创建后及时更新进度，只在实际完成时标记完成。未完成列表会显示在聊天页面。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'update', 'complete_all'] },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 100 },
              text: { type: 'string', minLength: 1, maxLength: 500 },
              status: statusSchema,
            },
            required: ['id', 'text', 'status'],
            additionalProperties: false,
          },
        },
        id: { type: 'string', minLength: 1, maxLength: 100 },
        status: statusSchema,
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const conversation = await ctx.ai.updateRunConversation(context, (current) => {
        if (args.action === 'set') {
          if (!Array.isArray(args.items) || !args.items.length || args.id || args.status)
            throw new AiError('invalid_todo', '创建列表需要 items，不能包含单项更新参数')
          // 参数已由核心按工具 Schema 校验；核心再次校验持久化契约及重复标识。
          return { todos: args.items as unknown as ConversationTodo[] }
        }
        if (args.items !== undefined)
          throw new AiError('invalid_todo', '仅创建列表时可以传入 items')
        const todos = current.todos ?? []
        if (!todos.length) throw new AiError('invalid_todo', '当前会话尚无待办列表')
        if (args.action === 'complete_all') {
          if (args.id !== undefined || args.status !== undefined)
            throw new AiError('invalid_todo', '完成整个列表不需要单项更新参数')
          return { todos: todos.map((item) => ({ ...item, status: 'completed' })) }
        }
        if (!todos.some((item) => item.id === args.id) || typeof args.status !== 'string')
          throw new AiError('invalid_todo', '更新需要有效的待办项 id 与 status')
        return {
          todos: todos.map((item) =>
            item.id === args.id
              ? { ...item, status: args.status as ConversationTodo['status'] }
              : { ...item },
          ),
        }
      })
      return { items: (conversation.todos ?? []).map((item) => ({ ...item })) }
    },
  })
}
