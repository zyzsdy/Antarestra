import type { DynamicReplyPolicy } from '@antarestra/im'
import { dynamicReplyDefaults } from '@antarestra/im/activation'

export interface DynamicReplyState {
  silentMessages: number
  hotStartedAt?: number
}

/** n 包含当前这条有效文本；热度按时间回落，沉默压力按消息数量增长。 */
export function dynamicReplyProbability(
  policy: DynamicReplyPolicy,
  state: DynamicReplyState,
  now: number,
) {
  const config = { ...dynamicReplyDefaults, ...policy }
  const progress = Math.min(1, Math.max(0, state.silentMessages / config.maxSilentMessages))
  if (progress >= 1) return 1
  const age = state.hotStartedAt === undefined ? Infinity : Math.max(0, now - state.hotStartedAt)
  // 归一化指数衰减：窗口开始为 1，结束精确为 0，无突跳。
  const heat =
    age >= config.hotDurationMs
      ? 0
      : Math.expm1(5 * (1 - age / config.hotDurationMs)) / Math.expm1(5)
  const baseline =
    config.baseProbability + Math.max(0, config.hotProbability - config.baseProbability) * heat
  const pressure = Math.expm1(10 * progress) / Math.expm1(10)
  return baseline + (1 - baseline) * pressure
}

/** 成功入队后重新累计基础概率，不提前增加热点概率。 */
export function recordDynamicActivation(state: DynamicReplyState) {
  state.silentMessages = 0
}

/** 有效非空回复开启热点，窗口内不续期；自主沉默立即退回基础概率。 */
export function recordDynamicReply(
  policy: DynamicReplyPolicy,
  state: DynamicReplyState,
  now: number,
  replied: boolean,
) {
  if (!replied) {
    delete state.hotStartedAt
    return
  }
  if (
    state.hotStartedAt === undefined ||
    now - state.hotStartedAt >= (policy.hotDurationMs ?? dynamicReplyDefaults.hotDurationMs)
  )
    state.hotStartedAt = now
}
