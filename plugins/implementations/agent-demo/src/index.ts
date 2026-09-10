import type { Context } from 'cordis'
import type { AgentBackend } from '@antarestra/agent'

export interface Config {
  backendId: string
  prefix: string
}

export const name = 'agent-demo'
export const inject = ['agents']

export function apply(ctx: Context, config: Config): void {
  const backend: AgentBackend = {
    async *run(request) {
      if (request.signal.aborted) {
        yield { type: 'cancelled' }
        return
      }
      const message = request.messages.at(-1)
      yield { type: 'text-delta', text: `${config.prefix}${message?.content ?? ''}` }
      yield { type: 'completed' }
    },
  }
  ctx.agents.backends.register(ctx, config.backendId, backend)
}
