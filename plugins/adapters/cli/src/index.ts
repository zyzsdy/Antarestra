import type { Context } from 'cordis'
import type {} from '@antarestra/agent'

export const name = 'adapter-cli'
export const inject = ['agents']

// 仅用于启动冒烟验证，后续再扩展为交互式聊天入口。
export async function apply(ctx: Context): Promise<void> {
  const controller = new AbortController()
  ctx.effect(() => () => controller.abort())
  for (const backendId of ctx.agents.backends.list()) {
    for await (const event of ctx.agents.backends.get(backendId).run({
      context: {
        actorId: 'demo-user',
        workspaceId: 'demo-workspace',
        conversationId: 'demo-conversation',
        channelInstanceId: 'cli-demo',
      },
      messages: [{ role: 'user', content: '插件骨架已就绪' }],
      signal: controller.signal,
    })) {
      if (event.type === 'text-delta') console.log(`[${backendId}] ${event.text}`)
    }
  }
}
