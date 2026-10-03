import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineDatabasePlugin } from '@antarestra/database'
import { WakeTasksService } from './service.js'
import type { Config } from './service.js'
import { migrations, pluginId } from './store.js'

export { WakeTasksService } from './service.js'
export type { Config } from './service.js'
export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['ai'],
  async apply(ctx: Context, input: Partial<Config> = {}) {
    const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
    await ctx.plugin(WakeTasksService, config)
    await ctx.plugin({
      inject: ['wakeTasks', 'ai'],
      apply(owner: Context) {
        owner.ai.registerTool(owner, {
          id: 'wake_task_create',
          description:
            '设置未来定时唤醒任务。必须给出包含时区的 triggerAt、触发原因 reason、触发时作为新会话用户输入的完整 prompt。默认 once 只执行一次；interval 需给出 intervalSeconds（至少60秒），以首次时间为锚点周期执行。停机漏过多次只补一次。自动关联当前空间、会话、身份和助理，每次在原空间用同一助理开启独立新会话，不能依赖原会话上下文；提示词须自包含。',
          parameters: {
            type: 'object',
            properties: {
              triggerAt: {
                type: 'string',
                description: '未来 ISO 8601 时间，必须包含 Z 或 ±HH:mm 时区。',
              },
              mode: { type: 'string', enum: ['once', 'interval'], default: 'once' },
              intervalSeconds: { type: 'integer', minimum: 60, maximum: 31536000 },
              reason: { type: 'string', minLength: 1, maxLength: 2000 },
              prompt: { type: 'string', minLength: 1, maxLength: 100000 },
            },
            required: ['triggerAt', 'reason', 'prompt'],
            additionalProperties: false,
          },
          execute: (args, context) => owner.wakeTasks.create(args, context),
        })
        owner.ai.registerTool(owner, {
          id: 'wake_task_list',
          description:
            '分页查看当前工作空间的定时唤醒任务及最近执行会话、运行和错误；存在 nextCursor 时继续读取。',
          parameters: {
            type: 'object',
            properties: {
              after: { type: 'string', maxLength: 200 },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
            },
            additionalProperties: false,
          },
          execute: (args, context) =>
            owner.wakeTasks.list(
              context,
              args.after as string | undefined,
              args.limit as number | undefined,
            ),
        })
        owner.ai.registerTool(owner, {
          id: 'wake_task_cancel',
          description:
            '取消当前空间指定定时唤醒任务，停止后续触发；正在运行的任务会在下一次租约检查时取消。',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 1, maxLength: 200 } },
            required: ['id'],
            additionalProperties: false,
          },
          execute: (args, context) => owner.wakeTasks.cancel(context, String(args.id)),
        })
        owner.wakeTasks.start()
      },
    })
  },
})
