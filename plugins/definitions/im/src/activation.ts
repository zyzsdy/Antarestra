import type { DynamicReplyPolicy, ChatPolicy } from './types.js'

export const historyPolicyLimits = {
  historyLimit: [1, 200],
  maxImages: [0, 20],
  maxFiles: [0, 20],
  mediaRetentionDays: [0, 36500],
  mediaMaxBytes: [0, Number.MAX_SAFE_INTEGER],
  queueLimit: [1, 100],
} as const
export function invalidHistoryField(policy: ChatPolicy) {
  for (const key of Object.keys(historyPolicyLimits) as (keyof typeof historyPolicyLimits)[]) {
    const value = policy[key],
      [min, max] = historyPolicyLimits[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
      return key
  }
}

/** 无运行时依赖，供服务端与控制台共用。 */
export const dynamicReplyDefaults: Readonly<Required<DynamicReplyPolicy>> = Object.freeze({
  baseProbability: 0.002,
  hotProbability: 0.2,
  hotDurationMs: 120000,
  maxSilentMessages: 150,
})

export function invalidDynamicReplyField(
  policy: DynamicReplyPolicy,
): keyof DynamicReplyPolicy | undefined {
  const config = { ...dynamicReplyDefaults, ...policy }
  for (const key of ['baseProbability', 'hotProbability'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) return key
  }
  if (
    !Number.isInteger(config.hotDurationMs) ||
    config.hotDurationMs < 1000 ||
    config.hotDurationMs > 3600000
  )
    return 'hotDurationMs'
  if (
    !Number.isInteger(config.maxSilentMessages) ||
    config.maxSilentMessages < 1 ||
    config.maxSilentMessages > 100000
  )
    return 'maxSilentMessages'
}
