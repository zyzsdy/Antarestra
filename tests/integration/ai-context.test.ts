import { describe, expect, it, vi } from 'vitest'
import { defaultContextPolicy, resolveTokenAmount, validTokenAmount } from '@antarestra/contracts'
import type {
  ChatMessage,
  ContextPolicy,
  ContextSummary,
  RequestSnapshot,
  RunRecord,
} from '@antarestra/contracts'
import {
  budget,
  estimateRequest,
  projectSummaries,
  recentBoundary,
  sourceEntry,
  usageTokens,
} from '../../plugins/definitions/ai/src/context.js'
import { prepareContext } from '../../plugins/definitions/ai/src/context-manager.js'
import type { ContextHost } from '../../plugins/definitions/ai/src/context-manager.js'

const model = { providerId: 'p', modelId: 'm' }
const message = (id: string, text = id, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id,
  role,
  content: [{ type: 'text', text }],
})
function fixture(policy?: ContextPolicy) {
  const history = Array.from({ length: 5 }, (_, index) => ({
    id: `r${index}`,
    messages: [message(`u${index}`), message(`a${index}`, `a${index}`, 'assistant')],
  })) as RunRecord[]
  const current = message('current')
  const record = {
    id: 'run',
    workspaceId: 'space',
    conversationId: 'conversation',
    messages: [current],
    agent: {
      contextPolicy: policy ?? {
        compaction: { enabled: true, reserve: 100, keepRecent: 100, model: null, thinking: null },
        trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
      },
    },
  } as RunRecord
  const host: ContextHost = {
    record,
    history,
    summaries: [],
    parentNodeId: 'parent',
    position: () => 0,
    estimate: async (draft) => estimateRequest(draft),
    emitBudget: vi.fn(async () => {}),
    emitOperation: vi.fn(async () => {}),
    summarize: vi.fn(async () => ({ text: '保留的摘要', model, thinking: null, usage: [] })),
  }
  const draft: RequestSnapshot = {
    model,
    thinking: null,
    parameters: {},
    systemPrompt: '',
    tools: [],
    messages: [...history.flatMap((run) => run.messages), current],
  }
  return { host, draft, policy: record.agent.contextPolicy! }
}

describe('上下文预算与安全投影', () => {
  it('默认配置与百分比解析，不接受零、负数、非整数 token 或越界百分比', () => {
    expect(defaultContextPolicy().compaction).toMatchObject({
      enabled: true,
      reserve: 16000,
      keepRecent: 10000,
    })
    expect(resolveTokenAmount('12.5%', 10001)).toBe(1250)
    for (const value of [0, -1, 1.2, '0%', '100%', '101%', 'NaN', '16000', '1e2%'])
      expect(validTokenAmount(value)).toBe(false)
    for (const value of [16000, '0.1%', '99.9%']) expect(validTokenAmount(value)).toBe(true)
  })
  it('用量包含缓存且不重复加 totalTokens，无用量则回退', () => {
    expect(usageTokens({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })).toBe(100)
    expect(usageTokens({ totalTokens: 100, input: 10, cacheRead: 30 })).toBe(100)
    expect(usageTokens({ totalTokens: 0 })).toBeUndefined()
    expect(usageTokens({ input: -1 })).toBeUndefined()
    expect(usageTokens(undefined)).toBeUndefined()
  })
  it('估算计入中文、系统提示、工具及附件', () => {
    const { draft } = fixture()
    const empty = estimateRequest({ ...draft, messages: [] })
    expect(estimateRequest({ ...draft, messages: [message('a', '中文')] })).toBeGreaterThan(empty)
    expect(
      estimateRequest({
        ...draft,
        tools: [{ id: '工具', description: '参数', parameters: { type: 'object' } }],
      }),
    ).toBeGreaterThan(estimateRequest(draft))
    expect(
      estimateRequest({
        ...draft,
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', resourceId: 'f', mimeType: 'application/pdf', size: 10000 }],
          },
        ],
      }),
    ).toBeGreaterThan(10000)
    expect(budget(draft, 100, 10, 120, 'after')).toMatchObject({
      used: 120,
      remaining: 0,
      available: 0,
    })
  })
  it('指定三轮始终裁剪并把首条用户输入合并，原始历史不变', async () => {
    const { host, draft, policy } = fixture()
    policy.trimming.enabled = true
    const original = JSON.stringify(draft.messages)
    await prepareContext(host, draft, 10000)
    expect(draft.messages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'current'])
    expect(draft.messages[0]?.content).toEqual([...message('u0').content, ...message('u2').content])
    expect(
      JSON.stringify([...host.history.flatMap((run) => run.messages), ...host.record.messages]),
    ).toBe(original)
    expect(host.emitOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trim', status: 'completed' }),
      undefined,
    )
  })
  it('自动裁剪仅删除达到预算所需的整数轮次', async () => {
    const { host, draft, policy } = fixture()
    policy.trimming = { enabled: true, mode: 'auto', rounds: 3, keepFirst: false }
    host.estimate = async (request) => request.messages.length * 100
    await prepareContext(host, draft, 800)
    expect(draft.messages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'current'])
    expect(host.summarize).not.toHaveBeenCalled()
  })
  it('等于预算允许发送且不改主请求输出上限', async () => {
    const { host, draft } = fixture()
    host.estimate = async () => 900
    draft.maxOutputTokens = 999
    await prepareContext(host, draft, 1000)
    expect(draft.maxOutputTokens).toBe(999)
    expect(host.summarize).not.toHaveBeenCalled()
  })
  it('近期原文无法容纳、关闭压缩和无可压缩历史明确报错', async () => {
    for (const enabled of [true, false]) {
      const { host, draft, policy } = fixture()
      policy.compaction.enabled = enabled
      draft.messages = [message('current', '中'.repeat(2000))]
      await expect(prepareContext(host, draft, 1000)).rejects.toMatchObject({
        code: 'context_overflow',
      })
      expect(host.summarize).not.toHaveBeenCalled()
    }
    const { host, draft } = fixture(defaultContextPolicy())
    await expect(prepareContext(host, draft, 10000)).rejects.toMatchObject({
      code: 'context_policy_invalid',
    })
  })
  it('裁剪后仍超预算时压缩，保留当前用户原文并保存范围', async () => {
    const { host, draft, policy } = fixture()
    policy.trimming = { enabled: true, mode: 'rounds', rounds: 3, keepFirst: true }
    draft.messages.forEach((m) => {
      if (m.id !== 'current') m.content = [{ type: 'text', text: m.id! + '中'.repeat(80) }]
    })
    await prepareContext(host, draft, 850)
    expect(host.summarize).toHaveBeenCalledOnce()
    expect(draft.messages.at(-1)?.content).toEqual(message('current').content)
    expect(host.summaries).toHaveLength(1)
    expect(host.summaries[0]?.sources.length).toBeGreaterThan(0)
    expect(host.summaries[0]?.sources.some((s) => s.id === 'current')).toBe(false)
  })
  it('摘要只覆盖精确来源，分支修改或部分裁剪不得带回旧内容', () => {
    const { draft } = fixture()
    const summary = {
      id: 's',
      createdAt: 1,
      sources: draft.messages.slice(0, 4).flatMap((m) => sourceEntry(m).sources),
      text: '早期摘要',
    } as ContextSummary
    expect(projectSummaries(draft.messages, [summary])[0]?.summaryId).toBe('s')
    const changed = structuredClone(draft.messages)
    changed[0]!.content = [{ type: 'text', text: '改动' }]
    expect(projectSummaries(changed, [summary]).some((e) => e.summaryId)).toBe(false)
    expect(projectSummaries(draft.messages.slice(2), [summary]).some((e) => e.summaryId)).toBe(
      false,
    )
  })
  it('工具结果不能与调用分开，长轮次可以在完整调用组之间压缩', () => {
    const entries = [
      message('u'),
      {
        id: 'call',
        role: 'assistant' as const,
        content: [{ type: 'tool-call' as const, id: 't', name: 't', arguments: {} }],
      },
      {
        id: 'result',
        role: 'tool' as const,
        content: [
          { type: 'tool-result' as const, id: 't', content: '中'.repeat(1000), isError: false },
        ],
      },
      message('a', '完成', 'assistant'),
    ].map(sourceEntry)
    expect(recentBoundary(entries, 100)).toBe(1)
  })
  it('摘要保存失败不加入有效列表，事件终态为失败', async () => {
    const { host, draft } = fixture()
    draft.messages.forEach((m) => {
      if (m.id !== 'current') m.content = [{ type: 'text', text: '中'.repeat(100) }]
    })
    host.emitOperation = vi.fn(async (_operation, summary) => {
      if (summary) throw new Error('storage failed')
    })
    await expect(prepareContext(host, draft, 1000)).rejects.toThrow('storage failed')
    expect(host.summaries).toEqual([])
    expect(host.emitOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed' }),
    )
  })
})
