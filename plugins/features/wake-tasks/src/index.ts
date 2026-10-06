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
            '安排未来由当前助理执行的任务，适用于提醒、延后处理或定期检查。triggerAt 必须是带时区的未来时间；不确定当前时间时先用 get_datetime。默认 once 执行一次；interval 按 intervalSeconds 周期执行，以首次时间为起点，错过多次时只补执行一次。每次会在当前工作空间开启独立新会话，prompt 必须写全任务、必要背景和完成条件，不能依赖本次对话。返回的任务 id 可用于在任务列表中识别此任务或取消任务。',
          parameters: {
            type: 'object',
            properties: {
              triggerAt: {
                type: 'string',
                description:
                  '首次触发时间，须含秒和时区，例如 2026-10-07T09:00:00+08:00，且必须晚于当前时刻。',
              },
              mode: {
                type: 'string',
                enum: ['once', 'interval'],
                default: 'once',
                description: 'once：一次性任务；interval：固定间隔重复任务。',
              },
              intervalSeconds: {
                type: 'integer',
                minimum: 60,
                maximum: 31536000,
                description: '重复间隔，单位秒；interval 时必填，once 时不要填写。',
              },
              reason: {
                type: 'string',
                minLength: 1,
                maxLength: 2000,
                description: '简要说明为何创建此任务，便于后续识别。',
              },
              prompt: {
                type: 'string',
                minLength: 1,
                maxLength: 100000,
                description: '触发时提交给助理的完整任务指令，须包含独立执行所需的背景和要求。',
              },
            },
            required: ['triggerAt', 'reason', 'prompt'],
            additionalProperties: false,
          },
          execute: (args, context) => owner.wakeTasks.create(args, context),
        })
        owner.ai.registerTool(owner, {
          id: 'wake_task_list',
          description:
            '查看当前工作空间的定时任务，了解任务 id、状态、下次触发时间、最近执行会话和错误。取消前可用本工具确认目标任务。返回非空 nextCursor 时，将其作为 after 继续翻页。',
          parameters: {
            type: 'object',
            properties: {
              after: {
                type: 'string',
                maxLength: 200,
                description: '上一页返回的 nextCursor；第一页省略。',
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: '每页任务数，默认 20。',
              },
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
            '取消当前工作空间中待执行或正在执行的定时任务，停止后续触发。id 使用 wake_task_create 或 wake_task_list 返回的任务 id。正在执行的任务可能稍后才停止，取消不会撤销已经产生的结果。',
          parameters: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
                description: '要取消的任务 id，不是会话或运行 id。',
              },
            },
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
