import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentRegistry } from '@antarestra/agent'
import type { AgentRequest } from '@antarestra/agent'
import * as demo from '@antarestra/agent-demo'
import { ScopedRegistry } from '@antarestra/plugin-sdk'

const contexts: Context[] = []

function createContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function request(signal = new AbortController().signal): AgentRequest {
  return {
    context: {
      actorId: 'test-user',
      workspaceId: 'test-workspace',
      conversationId: 'test-conversation',
      channelInstanceId: 'test-cli',
    },
    messages: [{ role: 'user', content: '你好' }],
    signal,
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('Cordis 4 插件生命周期', () => {
  it('同一实现加载两份，卸载甲实例不影响乙实例', async () => {
    const ctx = createContext()
    await ctx.plugin(AgentRegistry)
    const first = await ctx.plugin(demo, { backendId: 'a', prefix: '甲：' })
    await ctx.plugin(demo, { backendId: 'b', prefix: '乙：' })
    expect(ctx.agents.backends.list()).toEqual(['a', 'b'])

    await first.dispose()
    expect(ctx.agents.backends.list()).toEqual(['b'])
    const events = await Array.fromAsync(ctx.agents.backends.get('b').run(request()))
    expect(events).toEqual([{ type: 'text-delta', text: '乙：你好' }, { type: 'completed' }])
    expect(() => ctx.agents.backends.get('a')).toThrow('能力不可用')
  })

  it('重复加载与卸载不残留注册项，根上下文销毁时一起回收', async () => {
    const ctx = createContext()
    await ctx.plugin(AgentRegistry)
    const registry = ctx.agents.backends
    for (let index = 0; index < 3; index++) {
      const instance = await ctx.plugin(demo, { backendId: 'a', prefix: '' })
      await instance.dispose()
      expect(registry.list()).toEqual([])
    }
    await ctx.plugin(demo, { backendId: 'a', prefix: '' })
    await ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
  })

  it('服务先卸载再恢复时，依赖它的实现随之清理和重新注册', async () => {
    const ctx = createContext()
    const definition = await ctx.plugin(AgentRegistry)
    const implementation = await ctx.plugin(demo, { backendId: 'a', prefix: '' })
    const oldRegistry = ctx.agents.backends
    await definition.dispose()
    expect(oldRegistry.list()).toEqual([])

    await ctx.plugin(AgentRegistry)
    await implementation.await()
    expect(ctx.agents.backends.list()).toEqual(['a'])
  })

  it('已取消的请求不会输出正文', async () => {
    const ctx = createContext()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(demo, { backendId: 'a', prefix: '' })
    const controller = new AbortController()
    controller.abort()
    expect(
      await Array.fromAsync(ctx.agents.backends.get('a').run(request(controller.signal))),
    ).toEqual([{ type: 'cancelled' }])
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
