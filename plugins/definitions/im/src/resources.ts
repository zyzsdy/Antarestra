import { ScopedRegistry, type Context } from '@antarestra/plugin-sdk'
import type { ImageResourceResolver } from './types.js'

/** 不使用 URL.hostname，避免大小写敏感的资源 ID 被转为小写。 */
export function imageResourceId(source: string): string | undefined {
  if (!source.startsWith('resource:')) return
  const match = /^resource:\/\/([A-Za-z0-9_-]|%[0-9A-Fa-f]{2}){1,600}$/.exec(source)
  if (!match) throw new Error('图片资源引用无效，应为 resource://资源ID')
  let id: string
  try {
    id = decodeURIComponent(source.slice('resource://'.length))
  } catch {
    throw new Error('图片资源 ID 编码无效')
  }
  if (!id || id.length > 200 || /[\s\u0000-\u001f]/.test(id)) throw new Error('图片资源 ID 无效')
  return id
}

/** 解析器随提供方回收；卸载取消并等待在途操作，旧调用不能穿过新注册。 */
export class ImageResources {
  private readonly registry = new ScopedRegistry<ImageResourceResolver>()

  register(owner: Context, resolver: ImageResourceResolver) {
    const controller = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const track = <T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>) => {
      const combined = AbortSignal.any([signal, controller.signal])
      const task = Promise.resolve().then(async () => {
        combined.throwIfAborted()
        const result = await action(combined)
        combined.throwIfAborted()
        return result
      })
      pending.add(task)
      void task.finally(() => pending.delete(task)).catch(() => {})
      return task
    }
    const unregister = this.registry.register(owner, 'image', {
      inspect: (workspaceId, id, signal) =>
        track(signal, (signal) => resolver.inspect(workspaceId, id, signal)),
      resolve: (workspaceId, id, signal) =>
        track(signal, (signal) => resolver.resolve(workspaceId, id, signal)),
    })
    return owner.effect(() => async () => {
      controller.abort()
      await unregister()
      await Promise.allSettled([...pending])
    })
  }

  get() {
    return this.registry.get('image')
  }
}
