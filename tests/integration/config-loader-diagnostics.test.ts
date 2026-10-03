import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@antarestra/plugin-sdk'
import * as loader from '@antarestra/config-loader'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 10 })
  vi.unstubAllEnvs()
})

async function setup(
  options: {
    config?: string
    disabled?: boolean
    timeout?: number
    resolve?: () => string
    import?: () => Promise<unknown>
    source?: string
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra diagnostics '))
  directories.push(directory)
  const filename = join(directory, 'main.yml')
  if (options.source !== undefined) await writeFile(join(directory, 'index.mjs'), options.source)
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'sample',
      keywords: ['antarestra-plugin'],
      antarestra: { configSchema: 'config.schema.json' },
    }),
  )
  await writeFile(
    join(directory, 'config.schema.json'),
    JSON.stringify({
      type: 'object',
      properties: { port: { type: 'integer' }, token: { type: 'string' } },
    }),
  )
  // 环境值刻意只写入临时文件，用于验证异常诊断不会泄露它。
  await writeFile(join(directory, '.env'), 'DIAGNOSTIC_TOKEN=private-env-value\n')
  await writeFile(
    filename,
    `loader:\n  initializationTimeoutMs: ${options.timeout ?? 1000}\nplugins:\n  ${options.disabled ? '~' : ''}sample: ${options.config ?? '{}'}\n`,
  )
  const ctx = new Context()
  contexts.push(ctx)
  const logs: unknown[][] = []
  ctx.logger.exporter({
    export(message) {
      if (message.name === 'config-loader' && message.type === 'error') logs.push(message.args)
    },
  })
  const resolver = loader.createPluginResolver(
    options.resolve ?? (() => pathToFileURL(join(directory, 'index.mjs')).href),
    options.import ?? (options.source === undefined ? async () => ({ default() {} }) : undefined),
  )
  await ctx.plugin(loader, { filename, resolvePlugin: resolver })
  return { ctx, filename, logs, manager: ctx.configManager }
}

function diagnostic(logs: unknown[][], index = 0) {
  expect(logs[index]?.[0]).toBe('插件加载诊断：%s')
  return JSON.parse(logs[index]?.[1] as string) as {
    diagnosticId: string
    instanceId: string
    stage: string
    code: string
    causes: { code: string; type: string }[]
  }
}

describe('Fiber 创建前的加载诊断', () => {
  it('真实模块缺少内部依赖时保留 Node 错误码，不回显文件路径', async () => {
    const app = await setup({
      source: "import './private-missing-dependency.mjs'; export default function () {}",
    })
    expect(diagnostic(app.logs)).toMatchObject({ stage: 'import', code: 'ERR_MODULE_NOT_FOUND' })
    const row = (await app.manager.snapshot()).instances[0]
    expect(row?.error).toContain('模块或内部依赖不存在')
    expect(JSON.stringify([row, app.logs])).not.toContain('private-')
    expect(JSON.stringify(app.logs)).not.toContain(app.filename)
  })

  it('保留受控原因链，面板与日志使用同一编号，不记录异常中的凭据', async () => {
    const cause = Object.assign(new Error('private-env-value dependency'), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    const failure = Object.assign(new Error('private-plugin-credential', { cause }), {
      name: 'private-error-name',
      code: 'private-error-code',
    })
    const app = await setup({
      config: '{ token: $DIAGNOSTIC_TOKEN }',
      import: async () => {
        throw failure
      },
    })
    const rows = (await app.manager.snapshot()).instances
    expect(rows[0]?.status).toBe('failed')
    expect(app.manager.instances.get('sample')?.fiber).toBeUndefined()
    expect(app.logs).toHaveLength(1)
    const record = diagnostic(app.logs)
    expect(record).toMatchObject({
      instanceId: 'sample',
      stage: 'import',
      code: 'ERR_MODULE_NOT_FOUND',
      causes: [
        { type: 'Error', code: 'UNKNOWN' },
        { type: 'Error', code: 'ERR_MODULE_NOT_FOUND' },
      ],
    })
    expect(rows[0]?.error).toContain(record.diagnosticId)
    expect(rows[0]?.error).toContain('模块或内部依赖不存在')
    expect(JSON.stringify([rows, app.logs])).not.toContain('private-')
  })

  it.each([
    [
      '缺少插件包',
      {
        resolve: () => {
          throw Object.assign(new Error('private-package'), { code: 'ERR_MODULE_NOT_FOUND' })
        },
      },
      'metadata',
      'ERR_PLUGIN_NOT_FOUND',
    ],
    [
      '错误导出',
      { import: async () => ({ default: 'private-export' }) },
      'import',
      'ERR_PLUGIN_INVALID_EXPORT',
    ],
    [
      '模块语法错误',
      {
        import: async () => {
          throw new SyntaxError('private-source')
        },
      },
      'import',
      'UNKNOWN',
    ],
    ['缺少环境变量', { config: '{ token: $UNSET_DIAGNOSTIC_TOKEN }' }, 'environment', 'UNKNOWN'],
    ['配置校验', { config: '{ port: private-value }' }, 'validation', 'UNKNOWN'],
    [
      '导入超时',
      { timeout: 10, import: () => new Promise<unknown>(() => {}) },
      'import',
      'ERR_PLUGIN_TIMEOUT',
    ],
  ] as const)('%s 有独立阶段和安全诊断', async (_name, options, stage, code) => {
    vi.stubEnv('UNSET_DIAGNOSTIC_TOKEN', undefined)
    const app = await setup(options)
    const row = (await app.manager.snapshot()).instances[0]
    expect(row?.status).toBe('failed')
    expect(app.logs).toHaveLength(1)
    expect(diagnostic(app.logs)).toMatchObject({ stage, code })
    expect(row?.error).toContain(diagnostic(app.logs).diagnosticId)
    expect(JSON.stringify([row, app.logs])).not.toContain('private-')
  })

  it('保存及应用磁盘配置的预校验失败也有诊断，且不修改活动实例', async () => {
    const app = await setup()
    const fiber = app.manager.instances.get('sample')?.fiber
    const before = await readFile(app.filename, 'utf8')
    const operation = { id: 'test', state: 'running' as const, saved: false, message: '' }
    await expect(
      app.manager.save(
        (await app.manager.snapshot()).version,
        'sample',
        'port: private-config-value',
        true,
        '',
        operation,
      ),
    ).rejects.toThrow('配置校验失败')
    expect(operation.saved).toBe(false)
    expect(await readFile(app.filename, 'utf8')).toBe(before)
    expect(app.manager.instances.get('sample')?.fiber).toBe(fiber)
    await writeFile(app.filename, 'plugins:\n  sample: { token: $UNSET_DIAGNOSTIC_TOKEN }\n')
    vi.stubEnv('UNSET_DIAGNOSTIC_TOKEN', undefined)
    const operationInfo = app.manager.enqueue(async () =>
      app.manager.applyDisk((await app.manager.snapshot()).version, 'sample'),
    )
    await vi.waitFor(() => expect(app.manager.operation(operationInfo.id).state).toBe('failed'))
    expect(app.logs).toHaveLength(2)
    expect(diagnostic(app.logs, 0).stage).toBe('validation')
    expect(diagnostic(app.logs, 1).stage).toBe('environment')
    expect(app.manager.operation(operationInfo.id).message).toContain(
      diagnostic(app.logs, 1).diagnosticId,
    )
    expect(app.manager.instances.get('sample')?.fiber).toBe(fiber)
    expect(JSON.stringify(app.logs)).not.toContain('private-')
  })

  it('循环原因、非 Error 抛出及属性 getter 不泄露数据也不阻塞加载', async () => {
    const getter = vi.fn(() => {
      throw new Error('private-getter')
    })
    const failure = Object.defineProperty({ cause: undefined as unknown }, 'code', { get: getter })
    failure.cause = failure
    const app = await setup({
      import: async () => {
        throw failure
      },
    })
    expect(getter).not.toHaveBeenCalled()
    expect(diagnostic(app.logs).causes).toEqual([{ code: 'UNKNOWN', type: 'Unknown' }])
    expect(JSON.stringify(app.logs)).not.toContain('private-')
  })

  it('重试成功清除失败提示；每次失败生成不同编号', async () => {
    let broken = true
    const app = await setup({
      import: async () => {
        if (broken) throw 'private-thrown-string'
        return { default() {} }
      },
    })
    await expect(
      app.manager.applyDisk((await app.manager.snapshot()).version, 'sample'),
    ).rejects.toThrow('诊断编号')
    expect(app.logs).toHaveLength(2)
    expect(diagnostic(app.logs).diagnosticId).not.toBe(diagnostic(app.logs, 1).diagnosticId)
    broken = false
    await app.manager.applyDisk((await app.manager.snapshot()).version, 'sample')
    expect((await app.manager.snapshot()).instances[0]).toMatchObject({
      status: 'active',
      error: '',
    })
    expect(JSON.stringify(app.logs)).not.toContain('private-')
  })
})
