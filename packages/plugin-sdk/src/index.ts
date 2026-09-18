import type { Context } from 'cordis'

// 统一提供 Cordis 运行时与类型，插件不必直接依赖底层运行时包。
export * from 'cordis'

/** 插件在 SDK 上扩展事件，由 SDK 桥接到 Cordis 的原生分发类型。 */
export interface Events {}
type PluginEvents = Events
declare module 'cordis' {
  interface Events extends PluginEvents {}
}

/** 注册项归属调用方上下文，卸载时自动释放，重复标识直接拒绝。 */
export class ScopedRegistry<T> {
  private readonly entries = new Map<string, T>()

  register(ctx: Context, id: string, value: T): () => Promise<void> {
    if (!id.trim()) throw new Error('注册标识不能为空')
    if (this.entries.has(id)) throw new Error(`注册标识重复：${id}`)

    return ctx.effect(() => {
      this.entries.set(id, value)
      let active = true
      return () => {
        if (!active) return
        active = false
        this.entries.delete(id)
      }
    })
  }

  get(id: string): T {
    const value = this.entries.get(id)
    if (value === undefined) throw new Error(`能力不可用：${id}`)
    return value
  }

  list(): readonly string[] {
    return [...this.entries.keys()]
  }
}
