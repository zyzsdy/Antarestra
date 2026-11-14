import type Hmr from '@cordisjs/hmr'

export { default as Hmr } from '@cordisjs/hmr'
export type { Loader } from '@cordisjs/loader'

/** 将公开的 HMR 事务入口纳入配置管理生命周期队列，回收时等待已执行的事务。 */
export function coordinateHmr(
  instance: Pick<Hmr, 'reconcile'>,
  exclusive: <T>(action: () => Promise<T>) => Promise<T>,
): () => Promise<void> {
  const original = instance.reconcile
  const running = new Set<Promise<Hmr.Result>>()
  let active = true
  const wrapped: Hmr['reconcile'] = (callback) =>
    exclusive(async () => {
      if (!active) return { settled: [], aborted: [], skipped: [] }
      const task = original.call(instance, callback)
      running.add(task)
      try {
        return await task
      } finally {
        running.delete(task)
      }
    })
  instance.reconcile = wrapped
  return async () => {
    active = false
    if (instance.reconcile === wrapped) instance.reconcile = original
    await Promise.allSettled(running)
  }
}
