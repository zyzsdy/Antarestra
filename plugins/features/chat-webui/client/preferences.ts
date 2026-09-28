import type { ModelRef } from '@antarestra/contracts'
import type { Session } from './session.js'

interface Preference {
  model: ModelRef
  thinking: string | null
}

export function createChatPreferences() {
  const memory = new Map<string, Preference>()
  const key = (session: Session, agentId: string) =>
    `antarestra.chat.preferences.v1:${JSON.stringify([session.actorId, session.workspaceId, agentId])}`

  return {
    read(session: Session, agentId: string): Preference | undefined {
      const id = key(session, agentId)
      if (memory.has(id)) return memory.get(id)
      try {
        const raw = localStorage.getItem(id)
        if (!raw) return memory.get(id)
        const value: unknown = JSON.parse(raw)
        if (
          value &&
          typeof value === 'object' &&
          'model' in value &&
          value.model &&
          typeof value.model === 'object' &&
          'providerId' in value.model &&
          typeof value.model.providerId === 'string' &&
          'modelId' in value.model &&
          typeof value.model.modelId === 'string' &&
          'thinking' in value &&
          (value.thinking === null || typeof value.thinking === 'string')
        ) {
          return {
            model: { providerId: value.model.providerId, modelId: value.model.modelId },
            thinking: value.thinking,
          }
        }
      } catch {
        // 存储不可用或记录损坏时退回页面内存，不影响聊天。
      }
      return memory.get(id)
    },
    write(session: Session, agentId: string, preference: Preference) {
      const id = key(session, agentId)
      try {
        localStorage.setItem(id, JSON.stringify(preference))
        memory.delete(id)
      } catch {
        // 禁用存储或配额不足时仍可在当前页面恢复设置。
        memory.set(id, preference)
      }
    },
  }
}
