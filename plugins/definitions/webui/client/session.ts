import { shallowRef, shallowReadonly } from 'vue'
import type { ClientSession, SessionSnapshot } from '../src/client.js'

export const sessionStorageKey = 'antarestra.session.v1'

function parse(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (
    typeof item.actorId !== 'string' ||
    !item.actorId ||
    typeof item.displayName !== 'string' ||
    typeof item.accountPath !== 'string' ||
    !/^\/auth\/user\/(?:[a-z0-9-]+\/)?$/.test(item.accountPath) ||
    typeof item.expiresAt !== 'number' ||
    !Number.isFinite(item.expiresAt) ||
    item.expiresAt <= Date.now() ||
    !Array.isArray(item.permissions) ||
    !item.permissions.every((permission) => typeof permission === 'string')
  )
    return null
  // 只保存公开展示字段，不能把登录响应或令牌整体放入持久化存储。
  return {
    actorId: item.actorId,
    displayName: item.displayName,
    accountPath: item.accountPath,
    expiresAt: item.expiresAt,
    permissions: [...new Set(item.permissions as string[])],
    ...(item.passwordChangeRequired === true ? { passwordChangeRequired: true } : {}),
  }
}

export function createClientSession(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): ClientSession & { restore(): void } {
  const snapshot = shallowRef<SessionSnapshot | null>(null)
  function restore() {
    try {
      snapshot.value = parse(JSON.parse(storage?.getItem(sessionStorageKey) ?? 'null'))
    } catch {
      snapshot.value = null
    }
  }
  function clear() {
    snapshot.value = null
    try {
      storage?.removeItem(sessionStorageKey)
    } catch {
      /* 存储不可用时仍清除内存。 */
    }
  }
  restore()
  return {
    snapshot: shallowReadonly(snapshot),
    read() {
      if (snapshot.value && snapshot.value.expiresAt <= Date.now()) clear()
      return snapshot.value
    },
    set(value) {
      const safe = parse(value)
      if (!safe) {
        clear()
        return
      }
      snapshot.value = safe
      try {
        storage?.setItem(sessionStorageKey, JSON.stringify(safe))
      } catch {
        /* 隐私模式退回内存。 */
      }
    },
    clear,
    restore,
  }
}
