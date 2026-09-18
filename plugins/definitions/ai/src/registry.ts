import type { Context } from '@antarestra/plugin-sdk'
import type { Registration } from './types.js'
import { AiError, identifier } from './utils.js'
export class Registry<T> {
  private entries = new Map<string, Registration<T>[]>()
  constructor(
    private removed: (entry: Registration<T>) => Promise<void>,
    private override = false,
  ) {}
  register(owner: Context, id: string, value: T): () => Promise<void> {
    identifier(id)
    if (!this.override && this.entries.get(id)?.length)
      throw new AiError('duplicate_registration', `重复注册：${id}`, 409)
    const entry: Registration<T> = { owner, value, active: true, token: {} }
    return owner.effect(() => {
      const stack = this.entries.get(id) ?? []
      stack.push(entry)
      this.entries.set(id, stack)
      return async () => {
        if (!entry.active) return
        entry.active = false
        const current = this.entries.get(id) ?? []
        const remaining = current.filter((item) => item !== entry)
        if (remaining.length) this.entries.set(id, remaining)
        else this.entries.delete(id)
        await this.removed(entry)
      }
    })
  }
  get(id: string): Registration<T> {
    const entry = this.entries.get(id)?.at(-1)
    if (!entry) throw new AiError('capability_unavailable', `能力不可用：${id}`, 503)
    return entry
  }
  list(): T[] {
    return [...this.entries.values()].map((stack) => stack.at(-1)!.value)
  }
}
