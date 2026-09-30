import { TestRegistry } from '../fixtures/registry.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@antarestra/plugin-sdk'
import type { Plugin } from '@antarestra/plugin-sdk'
import { resolveConfigEnvironment, validateConfig } from '@antarestra/plugin-sdk/schema'
import * as loader from '@antarestra/config-loader'
import type { Operation } from '@antarestra/config-loader'
import { resolvePlugin } from '../../apps/server/src/plugins.js'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 10 })
})
const operation = (): Operation => ({ id: 'test', state: 'running', saved: false, message: '' })
async function setup(source: string, resolver?: loader.PluginResolver) {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra config panel '))
  directories.push(directory)
  const filename = join(directory, 'main.yml')
  await writeFile(filename, source)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(loader, { filename, resolvePlugin: resolver ?? resolvePlugin })
  return { ctx, filename, manager: ctx.configManager }
}

describe('配置面板管理服务', () => {
  it('运行及禁用实例均展示包标题，详情与目录包含功能描述', async () => {
    const app = await setup('plugins:\n  logger: {}\n  ~hmr: {}\n  ~missing-plugin: {}\n')
    const items = (await app.manager.snapshot()).instances
    expect(items.find((item) => item.pluginId === 'logger')?.title).toBe('日志服务')
    expect(items.find((item) => item.pluginId === 'hmr')?.title).toBe('源码热重载')
    expect(items.find((item) => item.pluginId === 'missing-plugin')?.title).toBe('')
    const detail = await app.manager.detail('logger')
    expect(detail.info?.title).toBe('日志服务')
    expect(detail.info?.description).toContain('系统日志')
    const catalog = await app.manager.catalog()
    expect(catalog.find((item) => item.name === detail.info?.name)).toMatchObject({
      title: detail.info?.title,
      description: detail.info?.description,
    })
  })
  it.each(['', 'pluginPanel: {}\n', 'pluginPanel: { instances: {} }\n'])(
    '删除配置允许缺少面板元数据：%s',
    async (layout) => {
      const app = await setup(`plugins:\n  ~plugin-server: {}\n${layout}`)
      const result = operation()
      await app.manager.remove((await app.manager.snapshot()).version, 'plugin-server', result)
      expect(result.saved).toBe(true)
      expect((await app.manager.snapshot()).instances).toEqual([])
      expect((await loader.readDocument(app.filename)).entries).toEqual([])
    },
  )
  it('删除服务提供者由 Cordis 暂停消费者，缺失依赖可保存并删除', async () => {
    const cleaned = vi.fn()
    const resolver = async (id: string): Promise<Plugin<unknown>> =>
      id === 'provider'
        ? TestRegistry
        : {
            inject: ['testRegistry'],
            apply(ctx) {
              ctx.effect(() => cleaned)
            },
          }
    const app = await setup('plugins:\n  provider: {}\n  consumer: {}\n', resolver)
    await vi.waitFor(async () =>
      expect(
        (await app.manager.snapshot()).instances.every((item) => item.status === 'active'),
      ).toBe(true),
    )
    await app.manager.remove((await app.manager.snapshot()).version, 'provider', operation())
    await vi.waitFor(() => expect(cleaned).toHaveBeenCalledOnce())
    expect((await app.manager.snapshot()).instances[0]?.status).toBe('waiting')
    await app.manager.save(
      (await app.manager.snapshot()).version,
      'consumer',
      'value: 2',
      true,
      '',
      operation(),
    )
    expect((await app.manager.snapshot()).instances[0]?.status).toBe('waiting')
    await app.manager.remove((await app.manager.snapshot()).version, 'consumer', operation())
    expect((await app.manager.snapshot()).instances).toEqual([])
  })
  it('隔离初始化失败，保留禁用和缺失依赖实例，独立插件继续运行', async () => {
    const cleaned = vi.fn()
    const resolver = async (id: string): Promise<Plugin<unknown>> => {
      if (id === 'broken')
        return () => {
          throw new Error('不可回传的凭据')
        }
      if (id === 'waiting') return { inject: ['missing'], apply() {} }
      return (ctx) => {
        ctx.effect(() => cleaned)
      }
    }
    const app = await setup(
      'plugins:\n  good: {}\n  broken: {}\n  waiting: {}\n  ~disabled: { token: $MISSING }\n',
      resolver,
    )
    await vi.waitFor(async () => {
      const items = (await app.manager.snapshot()).instances
      expect(items.find((x) => x.instanceId === 'good')?.status).toBe('active')
      expect(items.find((x) => x.instanceId === 'broken')?.status).toBe('failed')
      expect(items.find((x) => x.instanceId === 'waiting')?.status).toBe('waiting')
      expect(items.find((x) => x.instanceId === 'disabled')?.status).toBe('disabled')
      expect(JSON.stringify(items)).not.toContain('不可回传的凭据')
    })
    expect(cleaned).not.toHaveBeenCalled()
  })
  it('保存后重载失败保留新配置；外部版本冲突不覆盖文件', async () => {
    const values: unknown[] = []
    const resolver = async (): Promise<Plugin<unknown>> => (_ctx, config) => {
      values.push(config)
      if ((config as { bad?: boolean }).bad) throw new Error('失败')
    }
    const app = await setup(
      '# 保留顶部注释\nplugins:\n  sample: # 实例说明\n    value: 1 # 字段说明\n',
      resolver,
    )
    await vi.waitFor(() => expect(values).toHaveLength(1))
    const detail = await app.manager.detail('sample')
    expect(detail.yaml).toContain('字段说明')
    const result = operation()
    await expect(
      app.manager.save(detail.version, 'sample', 'bad: true\n', true, '别名', result),
    ).rejects.toThrow()
    expect(result.saved).toBe(true)
    expect((await loader.readDocument(app.filename)).entries[0]?.config).toEqual({ bad: true })
    const before = await readFile(app.filename, 'utf8')
    await expect(
      app.manager.save(detail.version, 'sample', '{}', false, '', operation()),
    ).rejects.toThrow('已变化')
    expect(await readFile(app.filename, 'utf8')).toBe(before)
    expect(before).toContain('保留顶部注释')
  })
  it('禁用配置不要求环境变量，启用预校验失败不修改配置或运行实例', async () => {
    const app = await setup('plugins:\n  ~plugin-server: {}\n')
    const version = (await app.manager.snapshot()).version
    await app.manager.save(
      version,
      'plugin-server',
      'port: $UNSET_PANEL_PORT\n',
      false,
      '',
      operation(),
    )
    const saved = await readFile(app.filename, 'utf8')
    const nextVersion = (await app.manager.snapshot()).version
    await expect(
      app.manager.save(
        nextVersion,
        'plugin-server',
        'port: $UNSET_PANEL_PORT\n',
        true,
        '',
        operation(),
      ),
    ).rejects.toThrow('环境变量')
    expect(await readFile(app.filename, 'utf8')).toBe(saved)
  })
  it('短名称与完整包名重复时整个集合拒绝启动，禁用条目也计数', async () => {
    const app = await setup('plugins:\n  plugin-server: {}\n  ~@antarestra/plugin-server: {}\n')
    const rows = (await app.manager.snapshot()).instances
    expect(rows.map((x) => x.status)).toEqual(['failed', 'disabled'])
    expect(rows.every((x) => x.error.includes('重复'))).toBe(true)
    expect(app.ctx.get('server')).toBeUndefined()
  })
  it('扫描只返回插件包，添加禁用配置，不允许重复单实例', async () => {
    const app = await setup('plugins: {}\n')
    const catalog = await app.manager.catalog()
    expect(catalog.some((x) => x.name === '@antarestra/plugin-server')).toBe(true)
    expect(catalog.some((x) => x.name === '@antarestra/contracts')).toBe(false)
    await app.manager.add(
      (await app.manager.snapshot()).version,
      '@antarestra/plugin-server',
      operation(),
    )
    const snapshot = await app.manager.snapshot()
    expect(snapshot.instances[0]?.status).toBe('disabled')
    expect(snapshot.instances[0]?.instanceId).toBe('server')
    expect(await readFile(app.filename, 'utf8')).toContain('~server: {}')
    await expect(
      app.manager.add(snapshot.version, '@antarestra/plugin-server', operation()),
    ).rejects.toThrow('仅允许')
  })
  it.each([
    ['antarestra-plugin-example', false, 'example', false],
    ['@antarestra/plugin-example', false, 'example', false],
    ['@antarestra/example', false, 'example', false],
    ['@other/plugin-example', false, '@other/plugin-example', false],
    ['@antarestra/plugin-example', true, 'example', false],
    ['antarestra-plugin-example', true, 'example', false],
    ['@antarestra/plugin-example', false, '@antarestra/plugin-example', true],
  ])(
    '添加 %s（多实例 %s）使用可正确解析的配置键',
    async (name, multipleInstances, key, shadowed) => {
      const directory = await mkdtemp(join(tmpdir(), 'antarestra alias '))
      directories.push(directory)
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name,
          keywords: ['antarestra-plugin'],
          antarestra: { multipleInstances },
        }),
      )
      const resolver: loader.PluginResolver = async () => () => {}
      resolver.resolveUrl = (id) => {
        if (shadowed && id === 'example') return resolvePlugin.resolveUrl!('rbac')
        return pathToFileURL(join(directory, 'index.js')).href
      }
      const app = await setup('plugins: {}\n', resolver)
      vi.spyOn(app.manager, 'catalog').mockResolvedValue([
        { name, title: '', version: '', description: '', multipleInstances },
      ])
      await app.manager.add((await app.manager.snapshot()).version, name, operation())
      const entries = await loader.readConfig(app.filename)
      expect(entries[0]?.pluginId).toBe(key)
      expect(entries[0]?.enabled).toBe(false)
      if (multipleInstances) {
        expect(entries[0]?.instanceId.slice(key.length)).toMatch(/^:[a-f0-9]{8}$/)
        await app.manager.add((await app.manager.snapshot()).version, name, operation())
        const next = await loader.readConfig(app.filename)
        expect(next).toHaveLength(2)
        expect(next[0]?.instanceId).not.toBe(next[1]?.instanceId)
      } else {
        expect(entries[0]?.instanceId).toBe(key)
        await expect(
          app.manager.add((await app.manager.snapshot()).version, name, operation()),
        ).rejects.toThrow('仅允许')
      }
    },
  )
  it('未带后缀与带后缀的同包配置只阻止重复集合，不阻止其他插件', async () => {
    const app = await setup(
      'plugins:\n  plugin-server: {}\n  ~plugin-server:abcdef12: {}\n  ~plugin-logger: {}\n',
    )
    const rows = (await app.manager.snapshot()).instances
    expect(rows.map((item) => item.status)).toEqual(['failed', 'disabled', 'disabled'])
    expect(rows[0]?.error).toContain('重复')
  })
  it('清理异常不报告卸载成功，也不创建新实例', async () => {
    const started = vi.fn()
    const app = await setup('plugins:\n  sample: {}\n', async () => (ctx) => {
      started()
      ctx.effect(() => () => {
        throw new Error('清理失败测试')
      })
    })
    await vi.waitFor(async () =>
      expect((await app.manager.snapshot()).instances[0]?.status).toBe('active'),
    )
    await expect(
      app.manager.save(
        (await app.manager.snapshot()).version,
        'sample',
        'value: 2',
        true,
        '',
        operation(),
      ),
    ).rejects.toThrow('清理失败')
    expect(started).toHaveBeenCalledOnce()
    expect((await app.manager.snapshot()).instances[0]?.status).toBe('failed')
  })
  it('外部删除不立即卸载，逐实例应用后清理', async () => {
    const cleaned = vi.fn()
    const app = await setup('plugins:\n  sample: {}\n', async () => (ctx) => {
      ctx.effect(() => cleaned)
    })
    await vi.waitFor(async () =>
      expect((await app.manager.snapshot()).instances[0]?.status).toBe('active'),
    )
    await writeFile(app.filename, 'plugins: {}\n')
    const snapshot = await app.manager.snapshot()
    expect(snapshot.instances[0]?.removed).toBe(true)
    expect(cleaned).not.toHaveBeenCalled()
    await app.manager.applyDisk(snapshot.version, 'sample')
    expect(cleaned).toHaveBeenCalledOnce()
    expect((await app.manager.snapshot()).instances).toHaveLength(0)
  })
  it('等待依赖不消耗消费者初始化超时', async () => {
    let ready!: () => void
    const waiting = new Promise<void>((resolve) => {
      ready = resolve
    })
    const resolver = async (id: string): Promise<Plugin<unknown>> =>
      id === 'consumer'
        ? { inject: ['testRegistry'], apply() {} }
        : async (ctx) => {
            await waiting
            await ctx.plugin(TestRegistry)
          }
    const app = await setup(
      'loader: { initializationTimeoutMs: 150 }\nplugins:\n  consumer: {}\n  provider: {}\n',
      resolver,
    )
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(
      (await app.manager.snapshot()).instances.find((x) => x.instanceId === 'consumer')?.status,
    ).toBe('waiting')
    ready()
    await vi.waitFor(async () =>
      expect((await app.manager.snapshot()).instances.every((x) => x.status === 'active')).toBe(
        true,
      ),
    )
  })
  it('初始化超时与清理超时阻止重复加载，资源迟到结束后仍要求重启', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const app = await setup(
      'loader: { initializationTimeoutMs: 20, disposalTimeoutMs: 20 }\nplugins:\n  sample: {}\n',
      async () => async () => {
        await waiting
      },
    )
    try {
      await vi.waitFor(async () =>
        expect((await app.manager.snapshot()).instances[0]?.error).toContain('清理失败'),
      )
      await expect(
        app.manager.save(
          (await app.manager.snapshot()).version,
          'sample',
          '{}',
          true,
          '',
          operation(),
        ),
      ).rejects.toThrow('清理未完成')
    } finally {
      finish()
    }
  })
})

describe('统一配置 Schema', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      port: { type: 'integer', minimum: 1 },
      enabled: { type: 'boolean' },
      name: { type: 'string', default: '默认' },
    },
    required: ['port'],
  }
  it('严格转换环境变量，保持原始引用，不回传环境值', () => {
    const raw = { port: '$PORT', enabled: '$ENABLED' }
    const resolved = resolveConfigEnvironment(raw, { PORT: '14451', ENABLED: 'false' }, schema)
    expect(validateConfig(schema, resolved)).toEqual({ port: 14451, enabled: false, name: '默认' })
    expect(raw).toEqual({ port: '$PORT', enabled: '$ENABLED' })
    expect(() =>
      resolveConfigEnvironment(raw, { PORT: '1secret', ENABLED: 'false' }, schema),
    ).toThrow('PORT')
    expect(() => validateConfig(schema, { port: '14451' })).toThrow()
  })
  it('远程引用不会触发请求，缺失引用拒绝校验', () => {
    expect(() => validateConfig({ $ref: 'https://invalid.example/schema' }, {})).toThrow()
  })
  it('本地引用与字典元素同样按 Schema 转换环境变量', () => {
    const definition = {
      type: 'object',
      $defs: { port: { type: 'integer' } },
      properties: {
        port: { $ref: '#/$defs/port' },
        flags: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
        },
      },
    }
    expect(
      resolveConfigEnvironment(
        { port: '$PORT', flags: { debug: '$DEBUG' } },
        { PORT: '1234', DEBUG: 'false' },
        definition,
      ),
    ).toEqual({ port: 1234, flags: { debug: false } })
  })
  it('条件分支中的环境引用使用选中分支的类型', () => {
    const definition = {
      type: 'object',
      properties: { mode: { type: 'string' } },
      if: { properties: { mode: { const: 'numeric' } }, required: ['mode'] },
      then: { properties: { limit: { type: 'integer' } } },
      else: { properties: { limit: { type: 'boolean' } } },
    }
    expect(
      resolveConfigEnvironment({ mode: 'numeric', limit: '$LIMIT' }, { LIMIT: '12' }, definition),
    ).toEqual({ mode: 'numeric', limit: 12 })
    expect(
      resolveConfigEnvironment(
        '$VALUE',
        { VALUE: 'true' },
        { oneOf: [{ type: 'integer' }, { type: 'boolean' }] },
      ),
    ).toBe(true)
  })
})
