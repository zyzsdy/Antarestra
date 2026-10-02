import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { AiError, validateAgent } from '@antarestra/ai'
import type { AgentPreset } from '@antarestra/ai'
import { defaultContextPolicy } from '@antarestra/contracts'
import { AuthError } from '@antarestra/rbac'
import '@antarestra/database'
import { defaultAgentId, newAgent } from './types.js'
import type { AgentRecord } from './types.js'
import { name } from './store.js'
import type { Tables } from './store.js'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    aiAgents: AiAgentsService
  }
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new AuthError(400, message)
}
export function validateRecord(body: Record<string, unknown>): AgentRecord {
  const { revision, ...preset } = body
  check(Number.isSafeInteger(revision) && Number(revision) > 0, '配置版本无效')
  check(
    typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 200,
    '名称需为 1–200 字',
  )
  check(
    typeof body.systemTemplate === 'string' && body.systemTemplate.length <= 65536,
    '系统提示词最多 65536 字',
  )
  check(
    typeof body.userTemplate === 'string' && body.userTemplate.length <= 65536,
    '用户模板最多 65536 字',
  )
  const fallback = { providerId: 'validation', modelId: 'validation' }
  try {
    validateAgent({
      ...preset,
      version: String(revision),
      models:
        body.models === null || (Array.isArray(body.models) && body.models.length === 0)
          ? [fallback]
          : body.models,
      defaultModel: body.defaultModel === null ? fallback : body.defaultModel,
      toolIds: body.toolIds === null ? [] : body.toolIds,
    })
  } catch (error) {
    if (error instanceof AiError)
      throw new AuthError(400, 'Agent 配置格式无效，请检查上下文预算、模型、工具、Skill 和扩展配置')
    throw error
  }
  const value = JSON.parse(JSON.stringify(body)) as AgentRecord
  value.contextPolicy ??= defaultContextPolicy()
  check(!value.toolIds?.includes('use_skill'), 'use_skill 由 Skill 服务提供，请通过 Skill 范围配置')
  check(
    value.defaultModel === null ||
      value.models === null ||
      value.models.some(
        (m) =>
          m.providerId === value.defaultModel!.providerId &&
          m.modelId === value.defaultModel!.modelId,
      ),
    '默认模型必须属于允许列表',
  )
  return value
}
export class AiAgentsService extends Service {
  private entries = new Map<string, { record: AgentRecord; dispose: () => Promise<void> }>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  constructor(ctx: Context) {
    super(ctx, 'aiAgents')
    ctx.effect(() => async () => {
      this.closing = true
      await this.queue
      for (const entry of this.entries.values()) await entry.dispose()
      this.entries.clear()
    })
  }
  private db() {
    return this.ctx.database.scope<Tables>(this.ctx, name)
  }
  private lock<T>(action: () => Promise<T>) {
    const result = this.queue.then(() => {
      if (this.closing) throw new AuthError(503, 'Agents 服务已卸载')
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }
  private register(record: AgentRecord) {
    const dispose = this.ctx.ai.registerAgentDefinition(this.ctx, {
      id: record.id,
      isDefault: record.id === defaultAgentId,
      resolve: () => this.resolve(this.entries.get(record.id)!.record),
    })
    this.entries.set(record.id, { record, dispose })
  }
  private resolve(record: AgentRecord): AgentPreset | null {
    const capabilities = this.ctx.ai.capabilities()
    const models =
      record.models ??
      capabilities.providers.flatMap((p) =>
        p.models.map((m) => ({ providerId: p.id, modelId: m.id })),
      )
    if (!models.length) return null
    const defaultModel = record.defaultModel ?? models[0]!
    const { revision, ...fields } = record
    return {
      ...fields,
      version: String(revision),
      models,
      defaultModel,
      toolIds: record.toolIds ?? capabilities.tools.map((t) => t.id),
      skillIds: record.skillIds === null && !capabilities.skillsAvailable ? [] : record.skillIds,
    }
  }
  async initialize() {
    await this.db().transaction(async (db) => {
      const exists = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', defaultAgentId)
        .executeTakeFirst()
      if (!exists) {
        const record = newAgent(defaultAgentId, '默认助理')
        await db
          .insertInto('agents')
          .values({ id: record.id, payload: JSON.stringify(record) })
          .execute()
      }
    })
    for (const row of await this.db().selectFrom('agents').selectAll().orderBy('id').execute())
      this.register(validateRecord(JSON.parse(row.payload) as Record<string, unknown>))
  }
  list() {
    return [...this.entries.values()].map((entry) => structuredClone(entry.record))
  }
  detail(id: string) {
    const entry = this.entries.get(id)
    if (!entry) throw new AuthError(404, 'Agent 不存在')
    return structuredClone(entry.record)
  }
  save(body: Record<string, unknown>, id?: string) {
    return this.lock(async () => {
      const next = validateRecord(body)
      if (id) {
        const previous = this.detail(id)
        check(id === next.id, 'Agent ID 不可修改')
        if (previous.revision !== next.revision)
          throw new AuthError(409, '配置已变化，请关闭编辑器并刷新后重试')
        next.revision++
        await this.db()
          .updateTable('agents')
          .set({ payload: JSON.stringify(next) })
          .where('id', '=', id)
          .execute()
        this.entries.get(id)!.record = next
      } else {
        if (this.entries.has(next.id)) throw new AuthError(409, 'Agent ID 已存在')
        next.revision = 1
        // 先校验注册冲突；数据库写入失败时回收注册，不遗留虚假条目。
        this.register(next)
        try {
          await this.db()
            .insertInto('agents')
            .values({ id: next.id, payload: JSON.stringify(next) })
            .execute()
        } catch (error) {
          await this.entries.get(next.id)!.dispose()
          this.entries.delete(next.id)
          throw error
        }
      }
      return structuredClone(next)
    })
  }
  remove(id: string, revision: unknown) {
    return this.lock(async () => {
      if (id === defaultAgentId) throw new AuthError(403, '默认助理不能删除，但可以修改其全部配置')
      const previous = this.detail(id)
      if (revision !== previous.revision) throw new AuthError(409, '配置已变化，请刷新后重试')
      await this.db().deleteFrom('agents').where('id', '=', id).execute()
      await this.entries.get(id)!.dispose()
      this.entries.delete(id)
      return { success: true }
    })
  }
}
