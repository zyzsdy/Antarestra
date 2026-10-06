import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@antarestra/plugin-sdk'
import * as loader from '@antarestra/config-loader'
import type { Operation, PluginResolver } from '@antarestra/config-loader'
import { writeDocument } from '../../packages/config-loader/src/document.js'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture(base: string, local?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra local overlay '))
  directories.push(directory)
  const filename = join(directory, 'main.yml')
  await writeFile(filename, base)
  if (local !== undefined) await writeFile(join(directory, 'main.local.yml'), local)
  return { directory, filename, local: join(directory, 'main.local.yml'), base }
}

it('同目录同名 local 递归合并映射，数组、标量、null 覆盖，环境在合并后解析', async () => {
  const app = await fixture(
    `plugins:
  sample:
    nested: { keep: 1, change: 2 }
    list: [a, b]
    nullable: { old: true }
    replaced: false
    token: $MISSING_BASE_ENV
loader: { initializationTimeoutMs: 1000 }
`,
    `plugins:
  sample:
    nested: { change: 3 }
    list: [c]
    nullable: null
    replaced: { enabled: true }
    token: $OVERLAY_VALUE
  extra: {}
loader: { disposalTimeoutMs: 2000 }
`,
  )
  await writeFile(join(app.directory, '.env'), 'OVERLAY_VALUE=fixture-value\n')
  const result = await loader.readConfig(app.filename, {})
  expect(result.map((entry) => entry.pluginId)).toEqual(['sample', 'extra'])
  expect(result[0]?.config).toEqual({
    nested: { keep: 1, change: 3 },
    list: ['c'],
    nullable: null,
    replaced: { enabled: true },
    token: 'fixture-value',
  })
  const file = await loader.readDocument(app.filename)
  expect(file.settings).toMatchObject({ initializationTimeoutMs: 1000, disposalTimeoutMs: 2000 })
  expect(file.entries[0]?.config.token).toBe('$OVERLAY_VALUE')
  expect(file.writeFilename).toBe(app.local)
})

it('本地启停键覆盖同一实例并继承字段，不产生启用和禁用两份实例', async () => {
  const app = await fixture(
    'plugins: { sample: { value: 1 }, ~other: { value: 2 } }',
    'plugins: { ~sample: {}, other: { value: 3 } }',
  )
  expect((await loader.readDocument(app.filename)).entries).toEqual([
    { pluginId: 'sample', instanceId: 'sample', enabled: false, config: { value: 1 } },
    { pluginId: 'other', instanceId: 'other', enabled: true, config: { value: 3 } },
  ])
})

it.each(['', '# 本地说明\n', '{}', 'loader: { supervision: external }'])(
  '允许部分或空本地配置：%s',
  async (local) => {
    const app = await fixture('plugins: { sample: {} }', local)
    expect((await loader.readDocument(app.filename)).entries[0]?.pluginId).toBe('sample')
  },
)

it('只有 local 但基础文件不存在时不回退', async () => {
  const app = await fixture('plugins: {}', 'plugins: { extra: {} }')
  await rm(app.filename)
  await expect(loader.readDocument(app.filename)).rejects.toThrow('无法读取主配置文件')
})

it.each(['custom.yml', 'custom.yaml', 'custom.prod.yml', 'custom'])(
  '覆盖文件使用去掉扩展名后的名称加 .local.yml：%s',
  async (name) => {
    const app = await fixture('plugins: {}')
    const filename = join(app.directory, name)
    const stem = name === 'custom.prod.yml' ? 'custom.prod' : 'custom'
    const localFilename = join(app.directory, `${stem}.local.yml`)
    await writeFile(filename, 'plugins: { base: {} }')
    await writeFile(`${filename}.local`, 'plugins: { obsolete: {} }')
    await writeFile(localFilename, 'plugins: { local: {} }')
    const current = await loader.readDocument(filename)
    expect(current.entries.map((entry) => entry.pluginId)).toEqual(['base', 'local'])
    expect(current.writeFilename).toBe(localFilename)
    await writeDocument(filename, current.version, (document) => {
      document.setIn(['plugins', 'added'], {})
    })
    expect(await readFile(filename, 'utf8')).toBe('plugins: { base: {} }')
    expect(await readFile(localFilename, 'utf8')).toContain('added')
    expect(await readFile(`${filename}.local`, 'utf8')).toBe('plugins: { obsolete: {} }')
  },
)

it.each([
  'plugins: [invalid]',
  'plugins: { sample: {}, sample: {} }',
  'plugins: { sample: {}, ~sample: {} }',
  'plugins: { sample: &x {}, other: *x }',
  'plugins: { sample: { value: !unknown hidden-value } }',
  'loader: { supervision: invalid }',
  'unknown: hidden-value',
])('存在无效 local 时明确失败，不静默忽略：%s', async (local) => {
  const app = await fixture('plugins: {}', local)
  await expect(loader.readDocument(app.filename)).rejects.toThrow()
  try {
    await loader.readDocument(app.filename)
  } catch (error) {
    expect(String(error)).not.toContain('hidden-value')
  }
})

it('保存只写本地差异并保留未编辑的显式覆盖及注释，基础文件逐字不变', async () => {
  const app = await fixture(
    '# 基础注释\nplugins: { sample: { inherited: 1, pinned: 2 } }\n',
    '# 本地注释\nplugins:\n  sample:\n    pinned: 2 # 显式固定\n  extra: {}\n',
  )
  const current = await loader.readDocument(app.filename)
  await writeDocument(app.filename, current.version, (document) => {
    document.setIn(['plugins', 'sample', 'inherited'], 3)
  })
  expect(await readFile(app.filename, 'utf8')).toBe(app.base)
  const saved = await readFile(app.local, 'utf8')
  expect(saved).toContain('本地注释')
  expect(saved).toContain('显式固定')
  expect(saved).not.toContain('基础注释')
  await writeFile(app.filename, app.base.replace('pinned: 2', 'pinned: 4'))
  expect((await loader.readDocument(app.filename)).entries[0]?.config).toEqual({
    inherited: 3,
    pinned: 2,
  })
})

it('删除继承插件及字段写入删除标记，本地新增插件删除后不留无效覆盖', async () => {
  const app = await fixture(
    'plugins: { sample: { keep: 1, remove: 2 }, inherited: {} }',
    'plugins: { extra: {} }',
  )
  let file = await loader.readDocument(app.filename)
  file = await writeDocument(app.filename, file.version, (document) => {
    document.deleteIn(['plugins', 'sample', 'remove'])
    document.deleteIn(['plugins', 'inherited'])
    document.deleteIn(['plugins', 'extra'])
  })
  expect(file.entries).toEqual([
    { pluginId: 'sample', instanceId: 'sample', enabled: true, config: { keep: 1 } },
  ])
  expect(await readFile(app.local, 'utf8')).toContain('!delete')
  expect(await readFile(app.local, 'utf8')).not.toContain('extra')
  expect(await readFile(app.filename, 'utf8')).toBe(app.base)
  await writeFile(app.filename, app.base.replace('remove: 2', 'remove: 99, added: 3'))
  expect((await loader.readDocument(app.filename)).entries[0]?.config).toEqual({
    keep: 1,
    added: 3,
  })
})

it('数组和 null 的保存不会被错误转换为继承或删除，新增对象可删除继承字段', async () => {
  const app = await fixture(
    'plugins: { sample: { list: [1, 2], nullable: 1, object: { a: 1, b: 2 } } }',
    '{}',
  )
  const file = await loader.readDocument(app.filename)
  const next = await writeDocument(app.filename, file.version, (document) => {
    document.setIn(['plugins', 'sample'], { list: [], nullable: null, object: { a: 9 } })
  })
  expect(next.entries[0]?.config).toEqual({ list: [], nullable: null, object: { a: 9 } })
  expect(await readFile(app.filename, 'utf8')).toBe(app.base)
})

it.each(['base', 'local', 'create', 'remove'] as const)(
  '基础或覆盖层变化都会拒绝旧版本保存：%s',
  async (kind) => {
    const app = await fixture('plugins: { sample: {} }', kind === 'create' ? undefined : '{}')
    const file = await loader.readDocument(app.filename)
    if (kind === 'base') await writeFile(app.filename, `${app.base}\n# 外部修改`)
    if (kind === 'local' || kind === 'create') await writeFile(app.local, '# 外部修改\n{}')
    if (kind === 'remove') await rm(app.local)
    await expect(
      writeDocument(app.filename, file.version, (document) => {
        document.setIn(['plugins', 'sample', 'changed'], true)
      }),
    ).rejects.toMatchObject({ status: 409 })
  },
)

it('原子提交前再次核对两个文件，冲突时不覆盖并清理临时文件', async () => {
  const app = await fixture('plugins: { sample: {} }', '{}')
  const file = await loader.readDocument(app.filename)
  await expect(
    writeDocument(app.filename, file.version, (document) => {
      document.setIn(['plugins', 'sample', 'changed'], true)
      writeFileSync(app.local, '# 外部修改\n{}')
    }),
  ).rejects.toMatchObject({ status: 409 })
  expect(await readFile(app.local, 'utf8')).toBe('# 外部修改\n{}')
  expect((await readdir(app.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
})

it('没有 local 时保留原文件保存行为，非法保存不写入任何文件', async () => {
  const app = await fixture('# 基础注释\nplugins: { sample: {} }')
  let file = await loader.readDocument(app.filename)
  file = await writeDocument(app.filename, file.version, (document) =>
    document.setIn(['plugins', 'sample', 'value'], 1),
  )
  expect(await readFile(app.filename, 'utf8')).toContain('基础注释')
  expect(file.entries[0]?.config.value).toBe(1)
  const saved = await readFile(app.filename, 'utf8')
  await expect(
    writeDocument(app.filename, file.version, (document) =>
      document.set('loader', { supervision: 'invalid' }),
    ),
  ).rejects.toThrow()
  expect(await readFile(app.filename, 'utf8')).toBe(saved)
  expect(await readdir(app.directory)).toEqual(['main.yml'])
})

it('配置管理器保存、启停、删除、布局和启动设置统一写覆盖层，重载后保持结果', async () => {
  const app = await fixture('plugins: { sample: { value: 1, removed: true } }', '{}')
  const resolver: PluginResolver = async () => () => {}
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(loader, { filename: app.filename, resolvePlugin: resolver })
  const manager = ctx.configManager
  const operation = (): Operation => ({ id: 'test', state: 'running', saved: false, message: '' })
  await manager.save(
    (await manager.snapshot()).version,
    'sample',
    'value: 2',
    false,
    '本地别名',
    operation(),
  )
  expect((await loader.readDocument(app.filename)).entries[0]).toMatchObject({
    enabled: false,
    config: { value: 2 },
  })
  await manager.save(
    (await manager.snapshot()).version,
    'sample',
    'value: 3',
    true,
    '本地别名',
    operation(),
  )
  expect((await loader.readDocument(app.filename)).entries[0]).toMatchObject({
    enabled: true,
    config: { value: 3 },
  })
  await manager.layout(
    (await manager.snapshot()).version,
    { groups: [{ id: 'private', name: '本地分组' }], instances: { sample: { group: 'private' } } },
    operation(),
  )
  await manager.loaderSettings(
    (await manager.snapshot()).version,
    { supervision: 'external' },
    operation(),
  )
  await manager.remove((await manager.snapshot()).version, 'sample', operation())
  expect(await readFile(app.filename, 'utf8')).toBe(app.base)
  const next = await loader.readDocument(app.filename)
  expect(next.entries).toEqual([])
  expect(next.settings.supervision).toBe('external')
  expect(next.layout.instances.sample).toBeUndefined()
  const restored = new Context()
  contexts.push(restored)
  await restored.plugin(loader, { filename: app.filename, resolvePlugin: resolver })
  expect((await restored.configManager.snapshot()).instances).toEqual([])
})
