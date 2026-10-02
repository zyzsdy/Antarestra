import { randomUUID } from 'node:crypto'
import { defaultContextPolicy, resolveTokenAmount } from '@antarestra/contracts'
import type {
  ChatMessage,
  ContextBudget,
  ContextOperation,
  ContextSummary,
  RequestSnapshot,
  RunRecord,
} from '@antarestra/contracts'
import { AiError, json } from './utils.js'
import { budget, projectSummaries, recentBoundary, serializeHistory } from './context.js'
import type { ContextEntry } from './context.js'

export interface ContextHost {
  record: RunRecord
  history: RunRecord[]
  summaries: ContextSummary[]
  parentNodeId: string | null
  position(): number
  estimate(request: RequestSnapshot): Promise<number>
  emitBudget(value: ContextBudget): Promise<void>
  emitOperation(value: ContextOperation, summary?: ContextSummary): Promise<void>
  summarize(
    text: string,
    maxSummaryTokens: number,
  ): Promise<{
    text: string
    model: RequestSnapshot['model']
    thinking: string | null
    usage: ContextSummary['usage']
  }>
}

export async function prepareContext(host: ContextHost, draft: RequestSnapshot, window: number) {
  const policy = host.record.agent.contextPolicy ?? defaultContextPolicy()
  const reserve = resolveTokenAmount(policy.compaction.reserve, window)
  const keep = resolveTokenAmount(policy.compaction.keepRecent, window)
  if (
    reserve < 1 ||
    reserve >= window ||
    (policy.compaction.enabled && (keep < 1 || keep + reserve >= window))
  )
    throw new AiError(
      'context_policy_invalid',
      '上下文窗口不足以容纳输出预留和近期保留窗口，请调整助理高级配置',
    )
  const limit = window - reserve
  const original = json(draft.messages)
  const currentUser = host.record.messages.find((message) => message.role === 'user')?.id
  const firstUser = original.find((message) => message.role === 'user')
  const render = (messages: ChatMessage[]) => projectSummaries(messages, host.summaries)
  const measure = (entries: ContextEntry[]) =>
    host.estimate({ ...draft, messages: entries.map((entry) => entry.message) })
  let selected = original
  let entries = render(selected)
  let used = await measure(entries)
  await host.emitBudget(budget(draft, window, reserve, used, 'before'))
  let operation: ContextOperation | undefined
  const begin = async (kind: ContextOperation['kind'], before: number) => {
    operation = {
      id: randomUUID(),
      kind,
      status: 'running',
      position: host.position(),
      before,
      createdAt: Date.now(),
      endedAt: null,
    }
    await host.emitOperation(operation)
  }
  const complete = async (after: number, summary?: ContextSummary) => {
    operation = { ...operation!, status: 'completed', after, endedAt: Date.now() }
    await host.emitOperation(operation, summary)
    operation = undefined
  }
  try {
    if (policy.trimming.enabled) {
      const rounds = host.history.map((run) => new Set(run.messages.map((message) => message.id)))
      const removed = new Set<string | undefined>()
      const select = () => {
        const messages = original.filter((message) => !removed.has(message.id)).map(json)
        if (policy.trimming.keepFirst && firstUser && removed.has(firstUser.id)) {
          const user = messages.find((message) => message.role === 'user')
          if (user) user.content = [...json(firstUser.content), ...user.content]
        }
        return messages
      }
      for (const [index, round] of rounds.entries()) {
        const remove =
          policy.trimming.mode === 'rounds'
            ? index < rounds.length - policy.trimming.rounds
            : used > limit
        if (!remove) break
        if (!original.some((message) => round.has(message.id))) continue
        if (!operation) await begin('trim', used)
        for (const id of round) removed.add(id)
        selected = select()
        entries = render(selected)
        used = await measure(entries)
      }
      if (operation) await complete(used)
    }
    if (used > limit) {
      if (!policy.compaction.enabled)
        throw new AiError(
          'context_overflow',
          '上下文与输出预留超过模型窗口，请开启自动压缩、减少输入或调整裁剪设置',
        )
      await begin('compact', used)
      const emptyRequest = { ...draft, systemPrompt: '', tools: [], messages: [] }
      const overhead = await host.estimate(emptyRequest)
      const sizes: number[] = []
      for (const entry of entries)
        sizes.push(
          Math.max(
            1,
            (await host.estimate({ ...emptyRequest, messages: [entry.message] })) - overhead,
          ),
        )
      const boundary = recentBoundary(entries, keep, sizes)
      const protectedIds = new Set([currentUser])
      if (policy.trimming.enabled && policy.trimming.keepFirst) {
        const user = selected.find((message) => message.role === 'user')
        if (user) protectedIds.add(user.id)
      }
      const candidates = entries
        .slice(0, boundary)
        .filter((entry) => !entry.message.id || !protectedIds.has(entry.message.id))
      const candidateSet = new Set(candidates)
      const retained = entries.filter((entry) => !candidateSet.has(entry))
      const retainedTokens = await measure(retained)
      if (!candidates.length || retainedTokens >= limit)
        throw new AiError(
          'context_overflow',
          '近期原文、当前输入或工具声明已占满上下文，请减少输入或调整近期保留窗口',
        )
      const output = await host.summarize(
        serializeHistory(candidates),
        Math.max(1, limit - retainedTokens - 128),
      )
      const summary: ContextSummary = {
        id: randomUUID(),
        workspaceId: host.record.workspaceId,
        conversationId: host.record.conversationId,
        runId: host.record.id,
        parentNodeId: host.parentNodeId,
        sources: candidates.flatMap((entry) => entry.sources),
        firstKeptId: entries[boundary]?.sources[0]?.id ?? null,
        previousSummaryIds: candidates.flatMap((entry) =>
          entry.summaryId ? [entry.summaryId] : [],
        ),
        text: output.text,
        model: output.model,
        thinking: output.thinking,
        usage: output.usage,
        createdAt: Date.now(),
      }
      const projected = projectSummaries(selected, [...host.summaries, summary])
      const after = await measure(projected)
      if (after > limit || after >= used)
        throw new AiError(
          'context_overflow',
          '压缩结果仍超过上下文预算，请减少输入、调整保留窗口或更换压缩模型',
        )
      await complete(after, summary)
      host.summaries.push(summary)
      entries = projected
      used = after
    }
    draft.messages = entries.map((entry) => entry.message)
    await host.emitBudget(budget(draft, window, reserve, used, 'prepared'))
    return reserve
  } catch (error) {
    if (operation) {
      const cancelled = error instanceof AiError && error.code === 'cancelled'
      await host.emitOperation({
        ...operation,
        status: cancelled ? 'cancelled' : 'failed',
        endedAt: Date.now(),
        error: error instanceof AiError ? error.message : '上下文处理失败，请检查服务状态后重试',
      })
    }
    throw error
  }
}
