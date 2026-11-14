import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@antarestra/plugin-hmr'
import { coordinateHmr, type Hmr } from '@antarestra/plugin-sdk/hmr'

describe('HMR 事务回收', () => {
  it('卸载等待正在执行的事务，并恢复原入口', async () => {
    const pending = Promise.withResolvers<Hmr.Result>()
    const instance = { reconcile: () => pending.promise }
    const original = instance.reconcile
    const dispose = coordinateHmr(instance, (action) => action())
    const transaction = instance.reconcile()
    let disposed = false
    const closing = dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    const result = { settled: [], aborted: [], skipped: [] }
    pending.resolve(result)
    await closing
    expect(await transaction).toBe(result)
    expect(instance.reconcile).toBe(original)
  })

  it('卸载不等待尚未执行的配置队列，排队事务不会在卸载后执行', async () => {
    const gate = Promise.withResolvers<void>()
    let calls = 0
    const instance = {
      async reconcile() {
        calls++
        return { settled: [], aborted: [], skipped: [] }
      },
    }
    const dispose = coordinateHmr(instance, (action) => gate.promise.then(action))
    const transaction = instance.reconcile()
    await dispose()
    gate.resolve()
    expect(await transaction).toEqual({ settled: [], aborted: [], skipped: [] })
    expect(calls).toBe(0)
  })
})

describe('官方 HMR 接入', () => {
  it('默认目录固定在项目根目录，包含与排除配置允许空数组', () => {
    const base = resolve('目录 含空格')
    expect(resolveConfig({}, base).roots).toEqual([resolve(base, 'plugins')])
    expect(resolveConfig({ include: [], exclude: [] }, base).roots).toEqual([])
    expect(resolveConfig({ exclude: ['.'] }, base).roots).toEqual([])
    expect(resolveConfig({}, base).hmr.watch.enabled).toBe(false)
    const outside = resolve(base, '..', '外部 [插件]')
    expect(resolveConfig({ include: [outside] }, base).roots).toEqual([outside])
    expect(resolveConfig({ include: [outside], exclude: [outside] }, base).roots).toEqual([])
    expect(() => resolveConfig({ include: [''] }, base)).toThrow('include')
    expect(() => resolveConfig({ exclude: [42] } as never, base)).toThrow('exclude')
  })

  it.each([
    ['hmr-runner.mjs', 'HMR 验证通过'],
    ['hmr-managed.mjs', 'HMR 验证通过'],
    ['hmr-rbac.mjs', 'RBAC HMR 验证通过'],
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
