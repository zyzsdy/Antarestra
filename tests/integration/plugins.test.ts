import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import { TestRegistry, registration } from '../fixtures/registry.js'
import { ScopedRegistry } from '@antarestra/plugin-sdk'

const contexts: Context[] = []

function createContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('Cordis 4 插件生命周期', () => {
  it('同一实现加载两份，卸载甲实例不影响乙实例', async () => {
    const ctx = createContext()
    await ctx.plugin(TestRegistry)
    const first = await ctx.plugin(registration, { id: 'a', value: '甲：' })
    await ctx.plugin(registration, { id: 'b', value: '乙：' })
    expect(ctx.testRegistry.entries.list()).toEqual(['a', 'b'])

    await first.dispose()
    expect(ctx.testRegistry.entries.list()).toEqual(['b'])
    expect(ctx.testRegistry.entries.get('b')).toBe('乙：')
    expect(() => ctx.testRegistry.entries.get('a')).toThrow('能力不可用')
  })

  it('重复加载与卸载不残留注册项，根上下文销毁时一起回收', async () => {
    const ctx = createContext()
    await ctx.plugin(TestRegistry)
    const registry = ctx.testRegistry.entries
    for (let index = 0; index < 3; index++) {
      const instance = await ctx.plugin(registration, { id: 'a', value: '' })
      await instance.dispose()
      expect(registry.list()).toEqual([])
    }
    await ctx.plugin(registration, { id: 'a', value: '' })
    await ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
  })

  it('服务先卸载再恢复时，依赖它的实现随之清理和重新注册', async () => {
    const ctx = createContext()
    const definition = await ctx.plugin(TestRegistry)
    const implementation = await ctx.plugin(registration, { id: 'a', value: '' })
    const oldRegistry = ctx.testRegistry.entries
    await definition.dispose()
    expect(oldRegistry.list()).toEqual([])

    await ctx.plugin(TestRegistry)
    await implementation.await()
    expect(ctx.testRegistry.entries.list()).toEqual(['a'])
  })
})

describe('带归属的注册表', () => {
  it('拒绝重复标识，旧回收函数不会删除后来注册的新实例', async () => {
    const ctx = createContext()
    const registry = new ScopedRegistry<string>()
    const dispose = registry.register(ctx, 'a', '旧实例')
    expect(() => registry.register(ctx, 'a', '重复实例')).toThrow('注册标识重复')
    await dispose()
    registry.register(ctx, 'a', '新实例')
    await dispose()
    expect(registry.get('a')).toBe('新实例')
  })

  it('拒绝空标识和已销毁的上下文，不留下半注册状态', async () => {
    const ctx = createContext()
    const registry = new ScopedRegistry<string>()
    expect(() => registry.register(ctx, ' ', '无效')).toThrow('注册标识不能为空')
    const child = await ctx.plugin(() => {})
    await child.dispose()
    expect(() => registry.register(child.ctx, 'a', '无效')).toThrow()
    expect(registry.list()).toEqual([])
  })
})
