import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { AuthError } from '@antarestra/rbac'
import '@antarestra/ai'
import '@antarestra/database'
import { catalog, candidates, discover } from './catalog.js'
import { driver } from './driver.js'
import { name } from './store.js'
import type { Tables } from './store.js'
import type { ProviderRecord } from './types.js'
import {
  check,
  publicProvider,
  validateModel,
  validateProvider,
  validateBuiltinTools,
} from './validation.js'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    aiProvider: AiProviderService
  }
}
export class AiProviderService extends Service {
  private entries = new Map<string, { record: ProviderRecord; dispose: () => Promise<void> }>()
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private controller = new AbortController()
  private requests = new Set<Promise<unknown>>()
  constructor(ctx: Context) {
    super(ctx, 'aiProvider')
    ctx.effect(() => async () => {
      this.closing = true
      this.controller.abort()
      await this.queue
      await Promise.allSettled([...this.requests])
      for (const entry of this.entries.values()) await entry.dispose()
      this.entries.clear()
    })
  }
  private db() {
    return this.ctx.database.scope<Tables>(this.ctx, name)
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closing) throw new AuthError(503, '提供商服务已卸载')
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }
  private current(id: string, revision?: unknown) {
    const entry = this.entries.get(id)
    if (!entry) throw new AuthError(404, '提供商不存在')
    if (revision !== undefined && revision !== entry.record.revision)
      throw new AuthError(409, '配置已变化，请刷新后重试')
    return entry.record
  }
  private register(record: ProviderRecord) {
    const removeDriver = this.ctx.ai.registerDriver(this.ctx, driver(record))
    try {
      const removeProvider = this.ctx.ai.registerProvider(this.ctx, {
        id: record.id,
        title: record.name,
        baseUrl: record.baseUrl,
        driverId: `ai-provider:${record.id}`,
        models: record.models,
        builtinTools: (record.builtinTools ?? []).map((tool) => ({
          id: `provider:${record.id}:${tool.name}`,
          name: tool.name,
          description: `${tool.name} · ${tool.type}`,
          type: tool.type,
          options: tool.options,
          modelIds: tool.enabled
            ? tool.modelIds.filter((id) =>
                record.models.some(
                  (m) =>
                    m.id === id &&
                    m.tools &&
                    [
                      'openai-responses',
                      'azure-openai-responses',
                      'openai-codex-responses',
                    ].includes(record.api),
                ),
              )
            : [],
        })),
        resolveCredential: async () => record.apiKey,
      })
      this.entries.set(record.id, {
        record,
        dispose: async () => {
          await removeProvider()
          await removeDriver()
        },
      })
    } catch (error) {
      void removeDriver()
      throw error
    }
  }
  async initialize() {
    for (const row of await this.db().selectFrom('providers').selectAll().orderBy('id').execute())
      this.register(JSON.parse(row.payload) as ProviderRecord)
  }
  list() {
    return [...this.entries.values()].map((entry) => publicProvider(entry.record))
  }
  detail(id: string) {
    return publicProvider(this.current(id))
  }
  private async commit(next: ProviderRecord, previous?: ProviderRecord) {
    await this.entries.get(next.id)?.dispose()
    this.entries.delete(next.id)
    try {
      this.register(next)
      await this.db().transaction(async (db) => {
        if (previous)
          await db
            .updateTable('providers')
            .set({ payload: JSON.stringify(next) })
            .where('id', '=', next.id)
            .execute()
        else
          await db
            .insertInto('providers')
            .values({ id: next.id, payload: JSON.stringify(next) })
            .execute()
      })
    } catch (error) {
      await this.entries.get(next.id)?.dispose()
      this.entries.delete(next.id)
      if (previous && !this.closing) this.register(previous)
      throw error
    }
    return publicProvider(next)
  }
  save(body: Record<string, unknown>, id?: string) {
    return this.lock(async () => {
      if (id) check(Number.isSafeInteger(body.revision), '缺少配置版本')
      const previous = id ? this.current(id, body.revision) : undefined
      const next = validateProvider(body, previous)
      check(!id || next.id === id, '已有提供商 ID 不可修改')
      check(!next.builtin || catalog().some((item) => item.id === next.builtin), '内置提供商不存在')
      if (!id && this.entries.has(next.id)) throw new AuthError(409, '提供商 ID 已存在')
      return this.commit(next, previous)
    })
  }
  remove(id: string, revision: unknown) {
    return this.lock(async () => {
      check(Number.isSafeInteger(revision), '缺少配置版本')
      const previous = this.current(id, revision)
      await this.entries.get(id)!.dispose()
      this.entries.delete(id)
      try {
        await this.db().deleteFrom('providers').where('id', '=', id).execute()
      } catch (error) {
        if (!this.closing) this.register(previous)
        throw error
      }
      return { success: true }
    })
  }
  models(id: string, body: Record<string, unknown>) {
    return this.lock(async () => {
      check(Number.isSafeInteger(body.revision), '缺少配置版本')
      const previous = this.current(id, body.revision)
      check(Array.isArray(body.models) && body.models.length <= 10000, '模型列表无效')
      const models = body.models.map(validateModel)
      check(new Set(models.map((model) => model.id)).size === models.length, '模型 ID 重复')
      return this.commit({ ...previous, models, revision: previous.revision + 1 }, previous)
    })
  }
  async discover(id: string, remote: boolean) {
    const record = this.current(id)
    if (!remote) return { models: candidates(record), warning: '' }
    const request = discover(record, this.controller.signal)
    this.requests.add(request)
    try {
      return await request
    } finally {
      this.requests.delete(request)
    }
  }
  builtinTools(id: string, body: Record<string, unknown>) {
    return this.lock(async () => {
      check(Number.isSafeInteger(body.revision), '缺少配置版本')
      const previous = this.current(id, body.revision)
      check(
        ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(
          previous.api,
        ),
        '内置工具需要 OpenAI Responses 接口',
      )
      const builtinTools = validateBuiltinTools(body.tools, previous.models)
      return this.commit({ ...previous, builtinTools, revision: previous.revision + 1 }, previous)
    })
  }
}
