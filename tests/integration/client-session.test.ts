/// <reference lib="dom" />
import { afterEach, expect, it, vi } from 'vitest'
import {
  createClientSession,
  sessionStorageKey,
} from '../../plugins/definitions/webui/client/session.js'

afterEach(() => vi.useRealTimers())
const snapshot = () => ({
  actorId: 'test',
  displayName: '测试用户',
  accountPath: '/auth/user/',
  expiresAt: Date.now() + 60_000,
  permissions: ['admin.console.view'],
})
function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

it('持久化白名单展示字段，重载恢复、跨页签同步、退出和切换账号不会混用快照', () => {
  const backing = storage()
  const first = createClientSession(backing)
  const value = { ...snapshot(), token: '不得保存的测试令牌', sessionId: '不得保存' }
  first.set(value)
  expect(backing.getItem(sessionStorageKey)).not.toContain('token')
  expect(backing.getItem(sessionStorageKey)).not.toContain('sessionId')
  const second = createClientSession(backing)
  expect(second.read()).toEqual(first.read())
  first.set({ ...snapshot(), actorId: 'other', permissions: [] })
  second.restore()
  expect(second.read()?.actorId).toBe('other')
  expect(second.read()?.permissions).toEqual([])
  first.clear()
  second.restore()
  expect(second.read()).toBeNull()
})

it('过期或损坏的快照拒绝使用，存储被禁止时退回内存且仍能退出', () => {
  vi.useFakeTimers()
  const backing = storage()
  const session = createClientSession(backing)
  session.set(snapshot())
  vi.advanceTimersByTime(60_001)
  expect(session.read()).toBeNull()
  expect(backing.getItem(sessionStorageKey)).toBeNull()
  backing.setItem(sessionStorageKey, '{broken')
  expect(createClientSession(backing).read()).toBeNull()
  backing.setItem(
    sessionStorageKey,
    JSON.stringify({ ...snapshot(), accountPath: '//external.example' }),
  )
  expect(createClientSession(backing).read()).toBeNull()
  const unavailable = createClientSession({
    getItem() {
      throw new Error('拒绝')
    },
    setItem() {
      throw new Error('拒绝')
    },
    removeItem() {
      throw new Error('拒绝')
    },
  })
  unavailable.set(snapshot())
  expect(unavailable.read()?.actorId).toBe('test')
  unavailable.clear()
  expect(unavailable.read()).toBeNull()
})
