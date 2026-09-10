import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { AgentEvent, ChatMessage, RequestContext } from '@antarestra/contracts'
import { ScopedRegistry } from '@antarestra/plugin-sdk'

export interface AgentRequest {
  context: RequestContext
  messages: readonly ChatMessage[]
  signal: AbortSignal
}

// 这里只定义最小运行端口；pi 类型不得泄漏到契约层。
export interface AgentBackend {
  run(request: AgentRequest): AsyncIterable<AgentEvent>
}

declare module 'cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

export class AgentRegistry extends Service {
  readonly backends = new ScopedRegistry<AgentBackend>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }
}
