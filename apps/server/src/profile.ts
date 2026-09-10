import type { Context } from 'cordis'
import { AgentRegistry } from '@antarestra/agent'
import * as demo from '@antarestra/agent-demo'
import * as cli from '@antarestra/adapter-cli'

// 初始化阶段采用类型化装配，后续配置加载器应作为独立插件提供。
export async function installDevelopmentProfile(ctx: Context): Promise<void> {
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(demo, { backendId: 'demo-a', prefix: '演示实例甲：' })
  await ctx.plugin(demo, { backendId: 'demo-b', prefix: '演示实例乙：' })
  await ctx.plugin(cli)
}
