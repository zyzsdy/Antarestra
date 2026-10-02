import type { RunRecord } from '@antarestra/contracts'

/** 界面验证使用的完整模拟运行，不访问服务端或模型。 */
export function contextRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const model = { providerId: 'preview', modelId: 'model' }
  return {
    id: 'preview',
    conversationId: 'preview',
    workspaceId: 'preview',
    actorId: 'preview',
    userNodeId: 'user',
    replyNodeId: 'reply',
    status: 'completed',
    agent: {
      id: 'preview',
      version: '1',
      title: '界面验证',
      backendId: 'preview',
      systemTemplate: '',
      userTemplate: '',
      models: [model],
      defaultModel: model,
      toolIds: [],
      skillIds: [],
      extensions: {},
    },
    model,
    thinking: null,
    input: { text: '' },
    messages: [],
    requests: [],
    error: null,
    createdAt: 0,
    endedAt: 82000,
    ...overrides,
  }
}
