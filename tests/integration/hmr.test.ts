import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@antarestra/plugin-hmr'

describe('官方 HMR 接入', () => {
  it('默认目录固定在项目根目录，包含与排除配置允许空数组', () => {
    const base = resolve('目录 含空格')
    expect(resolveConfig({}, base).root).toEqual([resolve(base, 'plugins')])
    expect(resolveConfig({ include: [], exclude: [] }, base).root).toEqual([])
    expect(resolveConfig({ exclude: ['.'] }, base).ignored).toContain('**')
    expect(() => resolveConfig({ include: [''] }, base)).toThrow('include')
    expect(() => resolveConfig({ exclude: [42] } as never, base)).toThrow('exclude')
  })

  it.each([
    ['hmr-runner.mjs', 'HMR 验证通过'],
    ['hmr-watch.mjs', '开发监视验证通过'],
  ])(
    '真实 Node 进程验证：%s',
    async (filename, success) => {
      const child = spawn(
        process.execPath,
        [
          '--expose-internals',
          '--import',
          'tsx',
          '--conditions=development',
          fileURLToPath(new URL(`../fixtures/${filename}`, import.meta.url)),
        ],
        { cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true },
      )
      let output = ''
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error(output || 'HMR 测试超时'))
          }, 35_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('exit', (code) => {
            clearTimeout(timer)
            resolve(code)
          })
        })
        expect(code, output).toBe(0)
        expect(output).toContain(success)
      } finally {
        child.kill()
      }
    },
    40_000,
  )
})
