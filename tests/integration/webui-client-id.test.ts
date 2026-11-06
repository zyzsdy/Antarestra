import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientId } from '@antarestra/webui/client'

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => vi.unstubAllGlobals())

describe('浏览器标识兼容性', () => {
  it('原生 UUID 可用时保留 Crypto 调用上下文', () => {
    const crypto = {
      randomUUID: vi.fn(function (this: unknown) {
        expect(this).toBe(crypto)
        return '00112233-4455-4677-8899-aabbccddeeff'
      }),
      getRandomValues: vi.fn(),
    }
    vi.stubGlobal('crypto', crypto)
    expect(createClientId()).toBe('00112233-4455-4677-8899-aabbccddeeff')
    expect(crypto.getRandomValues).not.toHaveBeenCalled()
  })

  it.each([0, 255])('缺少 randomUUID 时正确设置版本、变体及前导零（随机字节 %i）', (value) => {
    const crypto = {
      getRandomValues(this: unknown, bytes: Uint8Array) {
        expect(this).toBe(crypto)
        return bytes.fill(value)
      },
    }
    vi.stubGlobal('crypto', crypto)
    expect(createClientId()).toBe(
      value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    )
  })

  it('使用真实随机源生成多个互不重复的 UUID v4', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })
    const ids = Array.from({ length: 1000 }, () => createClientId())
    expect(ids.every((id) => uuidV4.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
