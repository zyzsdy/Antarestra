import DatabaseProvider from '@antarestra/database'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import type { Plugin } from '@antarestra/plugin-sdk'
import { TestRegistry, registration } from '../fixtures/registry.js'
import * as loader from '@antarestra/config-loader'
import { resolvePlugin } from '../../apps/server/src/plugins.js'

async function resolveFixture(id: string): Promise<Plugin<unknown>> {
  if (id === 'test-registry') return TestRegistry
  if (id === 'test-registration') return registration as Plugin<unknown>
  throw new Error(`未知测试插件：${id}`)
}

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
  it('递归解析美元前缀，保留普通字符串、类型和变量原值', () => {
    const entries = loader.parseConfig(
      `plugins:
  test-registry:
    nested: { value: $TOKEN }
    list: [$EMPTY, plain, 42, true, null, value$TOKEN]
    $TOKEN: literal
`,
      { TOKEN: '$OTHER\nsecret: value', EMPTY: '' },
    )
    expect(entries[0]?.config).toEqual({
      nested: { value: '$OTHER\nsecret: value' },
      list: ['', 'plain', 42, true, null, 'value$TOKEN'],
      $TOKEN: 'literal',
    })
    expect(() => loader.parseConfig('plugins: { test-registry: { value: $MISSING } }', {})).toThrow(
      '未配置',
    )
    for (const value of ['$', '$1BAD', '$TOKEN/suffix', '${TOKEN}'])
      expect(() =>
        loader.parseConfig(`plugins:\n  test-registry:\n    value: '${value}'`, {}),
      ).toThrow('格式无效')
    expect(
      loader.parseConfig('plugins: { ~test-registry: { value: $MISSING } }', {})[0]?.enabled,
    ).toBe(false)
  })

  it('读取主配置同级 .env，进程值和空字符串优先且不污染进程环境', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-env-'))
    directories.push(directory)
    const filename = join(directory, 'antarestra.yml')
    await writeFile(filename, 'plugins: { test-registry: { value: $TOKEN, empty: $EMPTY } }')
    await writeFile(join(directory, '.env'), 'TOKEN="本地 # 密钥"\nEMPTY=fallback\n')
    const before = { ...process.env }
    expect((await loader.readConfig(filename, { TOKEN: '上下文', EMPTY: '' }))[0]?.config).toEqual({
      value: '上下文',
      empty: '',
    })
    expect((await loader.readConfig(filename, { TOKEN: undefined }))[0]?.config).toEqual({
      value: '本地 # 密钥',
      empty: 'fallback',
    })
    expect(process.env).toEqual(before)
    await rm(join(directory, '.env'))
    expect((await loader.readConfig(filename, { TOKEN: '独立', EMPTY: '' }))[0]?.config.value).toBe(
      '独立',
    )
    await expect(loader.readConfig(filename, {})).rejects.toThrow('未配置')
  })

  it('命令行覆盖固定默认位置，相对路径允许空格', () => {
    const options = {
      argv: ['--conf=custom config/main.yml'],
      cwd: resolve('another directory'),
      defaultPath: resolve('antarestra.yml'),
    }
    expect(loader.resolveConfigPath(options)).toBe(resolve(options.cwd, 'custom config/main.yml'))
    expect(loader.resolveConfigPath({ ...options, argv: [] })).toBe(options.defaultPath)
    expect(loader.resolveConfigPath({ ...options, argv: [] })).toBe(options.defaultPath)
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf='] })).toThrow('不能为空')
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf'] })).toThrow('--conf=')
    expect(() => loader.resolveConfigPath({ ...options, argv: ['--conf=a', '--conf=b'] })).toThrow(
      '只能指定一次',
    )
  })

  it('读取映射配置、空配置和禁用状态，保留持久化的实例标识', () => {
    const source = 'plugins:\n  test-registry:\n  ~test-registration:1234abcd:\n    id: disabled\n'
    const entries = loader.parseConfig(source)
    expect(entries).toEqual([
      { pluginId: 'test-registry', instanceId: 'test-registry', enabled: true, config: {} },
      {
        pluginId: 'test-registration',
        instanceId: 'test-registration:1234abcd',
        enabled: false,
        config: { id: 'disabled' },
      },
    ])
    expect(loader.parseConfig(source)).toEqual(entries)
    const id = loader.createInstanceId('@antarestra/test-registration')
    expect(id).toMatch(/^@antarestra\/test-registration:[a-f0-9]{8}$/)
    expect(loader.parseConfig(`plugins:\n  '${id}': {}`)[0]?.instanceId).toBe(id)
  })

  it.each([
    '',
    'plugins: []',
    'plugins: {}\nunknown: true',
    'plugins:\n  test-registry: {}\n  test-registry: {}',
    'plugins:\n  test-registry: {}\n  ~test-registry: {}',
    'plugins:\n  test-registry: false',
    'plugins:\n  test-registry: [1]',
    'plugins:\n  test-registry: {}\n  test-registry:1234abcd: {}',
    'plugins:\n  test-registry:invalid: {}',
    'plugins:\n  test-registry: &config {}\n  demo: *config',
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
  test-registry: {}
  test-registration:1234abcd: { id: first, value: '甲：' }
  test-registration:5678efab: { id: second, value: '乙：' }
  ~missing-plugin: {}
`)
    const resolver = vi.fn(resolveFixture)
    const instances = await loader.loadPlugins(ctx, entries, resolver)
    expect(resolver.mock.calls.map(([id]) => id)).toEqual([
      'test-registry',
      'test-registration',
      'test-registration',
    ])
    expect(ctx.testRegistry.entries.list()).toEqual(['first', 'second'])
    await instances.get('test-registration:1234abcd')!.dispose()
    expect(ctx.testRegistry.entries.list()).toEqual(['second'])
    expect(ctx.testRegistry.entries.get('second')).toBe('乙：')
    const registry = ctx.testRegistry.entries
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
      return registration as Plugin<unknown>
    }
    await expect(
      loader.loadPlugins(
        createContext(),
        loader.parseConfig(`plugins:
  resource: {}
  broken: { id: missing, value: '' }
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
  test-registration: { id: demo, value: '' }
  test-registry: {}
`),
      resolveFixture,
    )
    const registry = ctx.testRegistry.entries
    expect(registry.list()).toEqual(['demo'])
    await instances.get('test-registry')!.dispose()
    expect(registry.list()).toEqual([])
    await ctx.plugin(TestRegistry)
    await instances.get('test-registration')!.await()
    expect(ctx.testRegistry.entries.list()).toEqual(['demo'])
  })

  it('完整包名与别名均可解析，拒绝非插件模块', async () => {
    expect(await resolvePlugin('@antarestra/database')).toBe(DatabaseProvider)
    expect(await resolvePlugin('database')).toBe(DatabaseProvider)
    await expect(resolvePlugin('@antarestra/contracts')).rejects.toThrow()
  })
})
