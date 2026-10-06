import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { AiError } from '@antarestra/ai'
import type { ConversationTodo } from '@antarestra/ai'
import { datetimeTool } from './datetime.js'

const statusSchema = {
  type: 'string',
  enum: ['pending', 'in_progress', 'completed'],
  description: 'pending：待完成；in_progress：正在进行；completed：已实际完成。',
}
export const inject = ['ai']
export function apply(ctx: Context, config: Record<string, unknown> = {}) {
  schemaConfig(new URL('../config.schema.json', import.meta.url), config)
  ctx.ai.registerTool(ctx, datetimeTool)
  ctx.ai.registerTool(ctx, {
    id: 'rename_conversation',
    description:
      '为当前会话设置标题。在话题明确或发生变化时，用简洁、准确的标题概括内容，建议不超过 20 字。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 50, description: '新的完整会话标题。' },
      },
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
      '为当前会话中的复杂、多步骤任务维护待办计划。set 用 items 创建或替换整个列表；update 用 id 和 status 更新一项；complete_all 不带其他参数，将全部项目标记完成。每轮工作后检查并及时更新进度，只在实际完成时标记 completed。修改计划内容须用 set 提交完整列表，并保留未变化项目的 id。返回更新后的完整列表；尚未全部完成时会显示在聊天页面。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'update', 'complete_all'],
          description: 'set 传 items；update 传 id 和 status；complete_all 只传 action。',
        },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: '仅 set 使用：完整待办列表，会替换已有列表。',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 100,
                description: '列表内唯一且稳定的标识，后续 update 使用此值。',
              },
              text: { type: 'string', minLength: 1, maxLength: 500 },
              status: statusSchema,
            },
            required: ['id', 'text', 'status'],
            additionalProperties: false,
          },
        },
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: '仅 update 使用：已有待办项的 id。',
        },
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
