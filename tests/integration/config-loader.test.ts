import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import type { Plugin } from '@antarestra/plugin-sdk'
import { AgentRegistry } from '@antarestra/agent'
import * as demo from '@antarestra/agent-demo'
import * as loader from '@antarestra/config-loader'
import { resolvePlugin } from '../../apps/server/src/plugins.js'

const contexts: Context[] = []
const directories: string[] = []

function createContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('主配置查找与解析', () => {
  it('命令行覆盖环境变量，环境变量覆盖固定默认位置，相对路径允许空格', () => {
    const options = {
      argv: ['--conf=custom config/main.yml'],
      env: { ANTARESTRA_CONFIG: 'environment.yml' },
      cwd: resolve('another directory'),
      defaultPath: resolve('antarestra.yml'),
    }
    expect(loader.resolveConfigPath(options)).toBe(resolve(options.cwd, 'custom config/main.yml'))
    expect(loader.resolveConfigPath({ ...options, argv: [] })).toBe(
      resolve(options.cwd, 'environment.yml'),
    )
    expect(loader.resolveConfigPath({ ...options, argv: [], env: {} })).toBe(options.defaultPath)
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf='] })).toThrow('不能为空')
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf'] })).toThrow('--conf=')
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf=a', '--conf=b'] })).toThrow(
      '只能指定一次',
    )
  })

  it('读取映射配置、空配置和禁用状态，保留持久化的实例标识', () => {
    const source = 'plugins:\n  agent:\n  ~agent-demo:1234abcd:\n    backendId: disabled\n'
    const entries = loader.parseConfig(source)
    expect(entries).toEqual([
      { pluginId: 'agent', instanceId: 'agent', enabled: true, config: {} },
      {
        pluginId: 'agent-demo',
        instanceId: 'agent-demo:1234abcd',
        enabled: false,
        config: { backendId: 'disabled' },
      },
    ])
    expect(loader.parseConfig(source)).toEqual(entries)
    const id = loader.createInstanceId('@antarestra/agent-demo')
    expect(id).toMatch(/^@antarestra\/agent-demo:[a-f0-9]{8}$/)
    expect(loader.parseConfig(`plugins:\n  '${id}': {}`)[0]?.instanceId).toBe(id)
  })

  it.each([
    '',
    'plugins: []',
    'plugins: {}\nunknown: true',
    'plugins:\n  agent: {}\n  agent: {}',
    'plugins:\n  agent: {}\n  ~agent: {}',
    'plugins:\n  agent: false',
    'plugins:\n  agent: [1]',
    'plugins:\n  agent: {}\n  agent:1234abcd: {}',
    'plugins:\n  agent:invalid: {}',
    'plugins:\n  agent: &config {}\n  demo: *config',
    'plugins: [',
  ])('拒绝无效或歧义配置：%s', (source) => {
    expect(() => loader.parseConfig(source)).toThrow()
  })

  it('文件不存在时失败，不回退；YAML 错误不暴露配置正文', async () => {
    await expect(
      loader.readConfig(join(tmpdir(), 'missing-antarestra', 'main.yml')),
    ).rejects.toThrow('无法读取主配置文件')
    expect(() => loader.parseConfig('plugins: [secret-token')).toThrow('不是有效的 YAML')
    try {
      loader.parseConfig('plugins: [secret-token')
    } catch (error) {
      expect(String(error)).not.toContain('secret-token')
    }
  })
})

describe('配置驱动的插件生命周期', () => {
  it('加载两份独立配置，禁用条目不解析模块，独立卸载后保留另一实例', async () => {
    const ctx = createContext()
    const entries = loader.parseConfig(`plugins:
  agent: {}
  agent-demo:1234abcd: { backendId: first, prefix: '甲：' }
  agent-demo:5678efab: { backendId: second, prefix: '乙：' }
  ~missing-plugin: {}
`)
    const resolver = vi.fn(resolvePlugin)
    const instances = await loader.loadPlugins(ctx, entries, resolver)
    expect(resolver.mock.calls.map(([id]) => id)).toEqual(['agent', 'agent-demo', 'agent-demo'])
    expect(ctx.agents.backends.list()).toEqual(['first', 'second'])
    await instances.get('agent-demo:1234abcd')!.dispose()
    expect(ctx.agents.backends.list()).toEqual(['second'])
    const events = await Array.fromAsync(
      ctx.agents.backends.get('second').run({
        context: { actorId: 'a', workspaceId: 'w', conversationId: 'c', channelInstanceId: 'test' },
        messages: [{ role: 'user', content: '你好' }],
        signal: new AbortController().signal,
      }),
    )
    expect(events).toEqual([{ type: 'text-delta', text: '乙：你好' }, { type: 'completed' }])
    const registry = ctx.agents.backends
    await ctx.fiber.dispose()
    expect(registry.list()).toEqual([])
  })

  it('独立加载器插件从文件读取，卸载时等待子插件的异步清理', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra config '))
    directories.push(directory)
    const filename = join(directory, 'main.yml')
    await writeFile(filename, 'plugins:\n  resource: { value: 7 }\n')
    const cleaned = vi.fn()
    const plugin = (ctx: Context, config: unknown) => {
      expect(config).toEqual({ value: 7 })
      ctx.effect(() => async () => {
        await Promise.resolve()
        cleaned()
      })
    }
    const instance = await createContext().plugin(loader, {
      filename,
      resolvePlugin: async () => plugin,
    })
    expect(cleaned).not.toHaveBeenCalled()
    await instance.dispose()
    expect(cleaned).toHaveBeenCalledOnce()
  })

  it.each(['import', 'apply', 'dependency'])('发生 %s 失败时回收之前的资源', async (failure) => {
    const cleaned = vi.fn()
    const resolver = async (id: string): Promise<Plugin<unknown>> => {
      if (id === 'resource')
        return (ctx) => {
          ctx.effect(() => cleaned)
        }
      if (failure === 'import') throw new Error('secret-token')
      if (failure === 'apply')
        return () => {
          throw new Error('secret-token')
        }
      return demo as Plugin<unknown>
    }
    await expect(
      loader.loadPlugins(
        createContext(),
        loader.parseConfig(`plugins:
  resource: {}
  broken: { backendId: missing, prefix: '' }
`),
        resolver,
      ),
    ).rejects.toThrow(/broken/)
    expect(cleaned).toHaveBeenCalledOnce()
  })

  it('支持后声明的依赖，并在服务卸载及恢复时重新激活实例', async () => {
    const ctx = createContext()
    const instances = await loader.loadPlugins(
      ctx,
      loader.parseConfig(`plugins:
  agent-demo: { backendId: demo, prefix: '' }
  agent: {}
`),
      resolvePlugin,
    )
    const registry = ctx.agents.backends
    expect(registry.list()).toEqual(['demo'])
    await instances.get('agent')!.dispose()
    expect(registry.list()).toEqual([])
    await ctx.plugin(AgentRegistry)
    await instances.get('agent-demo')!.await()
    expect(ctx.agents.backends.list()).toEqual(['demo'])
  })

  it('完整包名与别名均可解析，拒绝非插件模块', async () => {
    expect(await resolvePlugin('@antarestra/agent')).toBe(AgentRegistry)
    expect(await resolvePlugin('@antarestra/agent-demo')).toBe(demo)
    await expect(resolvePlugin('@antarestra/contracts')).rejects.toThrow()
  })
})
