export { default as Hmr } from '@cordisjs/plugin-hmr'
export { TimerService } from '@cordisjs/plugin-timer'
export type { Loader } from '@cordisjs/plugin-loader'

/** 官方 HMR 1.1.x 的单一刷新入口适配；不得绕过项目的生命周期队列。 */
export function coordinateHmr(
  instance: object,
  exclusive: (action: () => Promise<void>) => Promise<void>,
): () => void {
  const target = instance as { partialReload?: () => Promise<void> }
  const original = target.partialReload
  if (typeof original !== 'function') throw new Error('当前 HMR 版本不支持生命周期队列适配')
  const wrapped = () => exclusive(() => original.call(instance))
  target.partialReload = wrapped
  return () => {
    if (target.partialReload === wrapped) target.partialReload = original
  }
}
