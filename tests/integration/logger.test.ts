import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import type { Message } from '@antarestra/plugin-sdk'
import * as plugin from '@antarestra/plugin-logger'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig } from '../../plugins/implementations/logger/src/config.js'
import {
  colorDepth,
  createColorizer,
  indexedColors,
  trueColors,
} from '../../plugins/implementations/logger/src/colors.js'
import { formatMessage } from '../../plugins/implementations/logger/src/format.js'
import { FileWriter } from '../../plugins/implementations/logger/src/file.js'

const directories: string[] = []
const contexts: Context[] = []
const writers: FileWriter[] = []

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'antarestra-logger-'))
  directories.push(path)
  return path
}

function context() {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

function freezeDate(day: string) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${day}T12:31:35`))
}

async function writer(config: plugin.Config = {}) {
  const output = new FileWriter(resolveConfig({ directory: await directory(), ...config }))
  await output.init()
  writers.push(output)
  return output
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.allSettled(writers.splice(0).map((output) => output.close()))
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('日志配置与格式', () => {
  it('提供约定的默认配置', () => {
    expect(resolveConfig()).toEqual({
      console: true,
      consoleLevel: 'info',
      file: false,
      fileLevel: 'debug',
      directory: '../../log',
      rotation: 'daily',
      retentionDays: 30,
      maxSize: 104857600,
    })
  })

  it.each([
    { console: 1 },
    { file: 'true' },
    { consoleLevel: 'trace' },
    { fileLevel: 'toString' },
    { consoleLevel: ['info'] },
    { directory: ' ' },
    { rotation: 'weekly' },
    { retentionDays: 0 },
    { maxSize: -1 },
    { maxSize: 1.5 },
    { retentionDays: Infinity },
    null,
    [],
  ])('拒绝非法配置 %j', (config) => {
    expect(() => resolveConfig(config as plugin.Config)).toThrow()
  })

  it('格式化本地时间、Cordis 占位符、多行、Error 和循环对象', () => {
    const message: Message = {
      sn: 1,
      ts: new Date('2026-09-11T12:31:35').getTime(),
      name: 'server',
      type: 'info',
      level: 2,
      args: ['[http-req] %s %d\n第二行', 'GET', 200],
    }
    expect(formatMessage(message)).toBe(
      '[info] 2026-09-11 12:31:35 [server] [http-req] GET 200\n' +
        '[info] 2026-09-11 12:31:35 [server] 第二行\n',
    )
    expect(formatMessage({ ...message, args: [new Error('失败')] })).toContain('Error: 失败')
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(formatMessage({ ...message, args: [circular] })).toContain('Circular')
    expect(formatMessage({ ...message, args: ['\x1b[31m正文\x1b[0m'] })).not.toContain('\x1b')
  })
})

describe('终端调色板与能力降级', () => {
  it('两套扩展调色板各有216种不同颜色且真彩色保持柔和', () => {
    expect(new Set(trueColors.map((rgb) => rgb.join(','))).size).toBe(216)
    expect(new Set(indexedColors).size).toBe(216)
    expect(indexedColors.every((index) => index >= 16 && index <= 255)).toBe(true)
    for (const rgb of trueColors) {
      expect(Math.min(...rgb)).toBeGreaterThan(60)
      expect(Math.max(...rgb)).toBeLessThan(220)
      expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(120)
    }
  })

  it('根据真实流接口检测能力，尊重NO_COLOR与重定向', () => {
    for (const depth of [1, 4, 8, 24]) {
      const stream = { isTTY: true, getColorDepth: () => depth }
      expect(colorDepth(stream, {})).toBe(depth)
      expect(colorDepth(stream, { NO_COLOR: '' })).toBe(1)
      expect(colorDepth({ ...stream, isTTY: false }, { FORCE_COLOR: '3' })).toBe(1)
    }
    expect(colorDepth({}, {})).toBe(1)
  })

  it('只着色插件标签，颜色固定且调色板用尽后循环', () => {
    expect(createColorizer(1)('server')).toBe('[server]')
    expect(createColorizer(4)('server')).toMatch(/^\x1b\[\d{2}m\[server\]\x1b\[0m$/)
    for (const depth of [8, 24]) {
      const colorize = createColorizer(depth)
      const codes = Array.from({ length: 216 }, (_, i) => colorize(`plugin-${i}`).split('m')[0])
      expect(new Set(codes).size).toBe(216)
      expect(colorize('plugin-0').split('m')[0]).toBe(codes[0])
      expect(colorize('next').split('m')[0]).toBe(codes[0])
      expect(codes[0]).toContain(depth === 24 ? '38;2;' : '38;5;')
    }
  })
})

describe('Cordis 输出器生命周期', () => {
  it('默认只输出info以上，不回放缓冲，不创建文件目录', async () => {
    const ctx = context()
    const path = join(await directory(), '未创建')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    ctx.logger.info('历史')
    const fiber = await ctx.plugin(plugin, { directory: path })
    await ctx.plugin({
      name: 'example',
      apply(owner: Context) {
        owner.logger.debug('调试')
        owner.logger.info('正文')
      },
    })
    expect(stdout.mock.calls.map(([line]) => line).join('')).toContain('[example] 正文')
    expect(stdout.mock.calls.map(([line]) => line).join('')).not.toMatch(/历史|调试/)
    await expect(readdir(path)).rejects.toThrow()
    await fiber.dispose()
    stdout.mockClear()
    ctx.logger.error('卸载之后')
    expect(stdout).not.toHaveBeenCalled()
    const restored = await ctx.plugin(plugin)
    ctx.logger.info('恢复')
    expect(stdout).toHaveBeenCalledTimes(1)
    expect(stdout.mock.calls[0]![0]).toContain('恢复')
    await restored.dispose()
  })

  it('文件与终端独立过滤，卸载排空写入队列并保持顺序', async () => {
    const path = await directory()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const ctx = context()
    const fiber = await ctx.plugin(plugin, {
      file: true,
      directory: path,
      rotation: 'none',
      consoleLevel: 'warn',
    })
    ctx.logger.debug('调试')
    ctx.logger.info('信息')
    ctx.logger('constructor').info('应被终端过滤')
    ctx.logger.warn('警告')
    ctx.logger.error('错误')
    for (let i = 0; i < 100; i++) ctx.logger.debug('序号 %d', i)
    await fiber.dispose()
    expect(stdout).toHaveBeenCalledTimes(2)
    const content = await readFile(join(path, 'antarestra.log'), 'utf8')
    expect(content).toMatch(/调试\n.*信息\n.*应被终端过滤\n.*警告\n.*错误\n/)
    expect(content.match(/序号 \d+/g)).toEqual(Array.from({ length: 100 }, (_, i) => `序号 ${i}`))
    expect(content).not.toContain('\x1b')
  })

  it('多个实例独立卸载，禁止同目录并发占用并在关闭后释放', async () => {
    const firstPath = await directory()
    const secondPath = await directory()
    const ctx = context()
    const first = await ctx.plugin(plugin, {
      console: false,
      file: true,
      directory: firstPath,
      rotation: 'none',
    })
    const second = await ctx.plugin(plugin, {
      console: false,
      file: true,
      directory: secondPath,
      rotation: 'none',
    })
    const conflicting = new FileWriter(resolveConfig({ directory: join(firstPath, '.') }))
    await expect(conflicting.init()).rejects.toThrow('占用')
    ctx.logger.info('共同')
    await first.dispose()
    ctx.logger.info('第二份')
    await second.dispose()
    expect(await readFile(join(firstPath, 'antarestra.log'), 'utf8')).not.toContain('第二份')
    expect(await readFile(join(secondPath, 'antarestra.log'), 'utf8')).toContain('第二份')
    const reopened = await writer({ directory: firstPath, rotation: 'none' })
    await reopened.close()
  })
})

describe('日志文件轮转与故障', () => {
  it('文件输出故障后终端仍可输出，卸载清理完成后目录可复用', async () => {
    freezeDate('2026-09-11')
    const path = await directory()
    const ctx = context()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const fiber = await ctx.plugin(plugin, { file: true, directory: path })
    await mkdir(join(path, 'antarestra-2026-09-12.log'))
    vi.setSystemTime(new Date('2026-09-12T12:00:00'))
    ctx.logger.info('触发文件故障')
    await expect.poll(() => stderr.mock.calls.length).toBe(1)
    stdout.mockClear()
    ctx.logger.info('终端继续')
    expect(stdout).toHaveBeenCalledTimes(1)
    expect(stdout.mock.calls[0]![0]).toContain('终端继续')
    // Cordis 捕获清理异常并交给原生日志；dispose 本身仍可等待完成。
    await fiber.dispose()
    const recovered = await writer({ directory: path, rotation: 'none' })
    await recovered.close()
  })

  it('按天轮转并按本地日历保留30天，仅清理自己的有效日期文件', async () => {
    freezeDate('2026-09-11')
    const path = await directory()
    for (const filename of [
      'antarestra-2026-08-12.log',
      'antarestra-2026-08-13.log',
      'antarestra-2026-02-30.log',
      '其他.log',
      'antarestra-size-000000.log',
    ])
      await writeFile(join(path, filename), '原有内容')
    await mkdir(join(path, 'antarestra-2025-01-01.log'))
    const output = await writer({ directory: path })
    expect(await readdir(path)).not.toContain('antarestra-2026-08-12.log')
    output.write('今日\n', Date.now())
    vi.setSystemTime(new Date('2026-09-12T00:00:01'))
    output.write('明日\n', Date.now())
    await output.close()
    expect(await readFile(join(path, 'antarestra-2026-09-11.log'), 'utf8')).toBe('今日\n')
    expect(await readFile(join(path, 'antarestra-2026-09-12.log'), 'utf8')).toBe('明日\n')
    expect(await readdir(path)).not.toContain('antarestra-2026-08-13.log')
    expect(await readdir(path)).toEqual(
      expect.arrayContaining([
        'antarestra-2026-02-30.log',
        '其他.log',
        'antarestra-size-000000.log',
        'antarestra-2025-01-01.log',
      ]),
    )
  })

  it('按UTF-8字节轮转、重启恢复大小、超大单条独占文件且不删除历史', async () => {
    const path = await directory()
    const output = await writer({ directory: path, rotation: 'size', maxSize: 8 })
    output.write('中文\n', Date.now())
    await output.close()
    const resumed = await writer({ directory: path, rotation: 'size', maxSize: 8 })
    resumed.write('a', Date.now())
    resumed.write('b\n', Date.now())
    resumed.write('超大单条日志\n', Date.now())
    resumed.write('尾\n', Date.now())
    await resumed.close()
    const files = (await readdir(path)).sort()
    expect(files).toHaveLength(4)
    expect(await Promise.all(files.map((file) => readFile(join(path, file), 'utf8')))).toEqual([
      '中文\na',
      'b\n',
      '超大单条日志\n',
      '尾\n',
    ])
  })

  it('不轮转模式跨日与重启均追加，相对目录以工作目录为基准', async () => {
    freezeDate('2026-09-11')
    const path = await directory()
    const output = await writer({ directory: path, rotation: 'none' })
    output.write('甲\n', Date.now())
    vi.setSystemTime(new Date('2026-12-12T00:00:00'))
    output.write('乙\n', Date.now())
    await output.close()
    const resumed = await writer({ directory: relative(process.cwd(), path), rotation: 'none' })
    resumed.write('丙\n', Date.now())
    await resumed.close()
    expect(await readdir(path)).toEqual(['antarestra.log'])
    expect(await readFile(join(path, 'antarestra.log'), 'utf8')).toBe('甲\n乙\n丙\n')
  })

  it('启动打开文件失败会释放目录占用', async () => {
    const path = await directory()
    await mkdir(join(path, 'antarestra.log'))
    const output = new FileWriter(resolveConfig({ directory: path, rotation: 'none' }))
    await expect(output.init()).rejects.toThrow()
    // 换用不同模式验证同一目录的资源锁已释放，无需删除故障目录。
    const recovered = await writer({ directory: path, rotation: 'size' })
    await recovered.close()
  })

  it('运行中失败只诊断一次，关闭报告失败并释放资源', async () => {
    freezeDate('2026-09-11')
    const path = await directory()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const output = await writer({ directory: path })
    await mkdir(join(path, 'antarestra-2026-09-12.log'))
    const tomorrow = new Date('2026-09-12T12:00:00').getTime()
    output.write('触发故障\n', tomorrow)
    output.write('不再写入\n', tomorrow)
    await expect(output.close()).rejects.toThrow('日志文件输出失败')
    expect(stderr).toHaveBeenCalledTimes(1)
    const recovered = await writer({ directory: path, rotation: 'none' })
    await recovered.close()
  })
})
