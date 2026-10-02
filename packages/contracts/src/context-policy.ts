import type { ContextPolicy, TokenAmount } from './ai.js'

export function defaultContextPolicy(): ContextPolicy {
  return {
    compaction: { enabled: true, reserve: 16000, keepRecent: 10000, model: null, thinking: null },
    trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
  }
}

export function validTokenAmount(value: unknown): value is TokenAmount {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?%$/.test(value)) return false
  const percent = Number(value.slice(0, -1))
  return percent > 0 && percent < 100
}

export function resolveTokenAmount(value: TokenAmount, window: number): number {
  return typeof value === 'number' ? value : Math.floor((Number(value.slice(0, -1)) * window) / 100)
}
