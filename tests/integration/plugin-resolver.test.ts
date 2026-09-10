import { describe, expect, it, vi } from 'vitest'
import { createPluginResolver, pluginCandidates } from '@antarestra/config-loader'

const candidates = [
  '@antarestra/example',
  '@antarestra/plugin-example',
  'antarestra-plugin-example',
  'example',
]

function missing(): Error {
  return Object.assign(new Error('包不存在'), { code: 'ERR_MODULE_NOT_FOUND' })
}

describe('插件自动包名解析', () => {
  it.each([0, 1, 2, 3])('按优先级选择第 %i 个可用候选，不导入其他包', async (index) => {
    const plugin = () => {}
    const resolveModule = vi.fn((specifier: string) => {
      if (candidates.indexOf(specifier) < index) throw missing()
      return `file:///${specifier}.js`
    })
    const importModule = vi.fn(async () => ({ default: plugin }))
    expect(pluginCandidates('example')).toEqual(candidates)
    expect(await createPluginResolver(resolveModule, importModule)('example')).toBe(plugin)
    expect(resolveModule.mock.calls.flat()).toEqual(candidates.slice(0, index + 1))
    expect(importModule).toHaveBeenCalledExactlyOnceWith(`file:///${candidates[index]}.js`)
  })

  it('带 scope 的完整包名仅精确匹配', async () => {
    const resolveModule = vi.fn((name: string) => name)
    const plugin = { apply() {} }
    expect(await createPluginResolver(resolveModule, async () => plugin)('@other/example')).toBe(
      plugin,
    )
    expect(resolveModule).toHaveBeenCalledExactlyOnceWith('@other/example')
  })

  it('所有候选不存在时报告全部尝试过的包名', async () => {
    const importModule = vi.fn()
    const resolver = createPluginResolver(() => {
      throw missing()
    }, importModule)
    await expect(resolver('example')).rejects.toThrow(candidates.join('、'))
    expect(importModule).not.toHaveBeenCalled()
  })

  it('包导出配置损坏时不回退', async () => {
    const error = Object.assign(new Error('无可用导出'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
    const resolveModule = vi.fn(() => {
      throw error
    })
    await expect(createPluginResolver(resolveModule)('example')).rejects.toBe(error)
    expect(resolveModule).toHaveBeenCalledOnce()
  })

  it.each(['dependency', 'evaluation', 'shape'])('命中包发生 %s 错误时不回退', async (kind) => {
    const resolveModule = vi.fn((name: string) => name)
    const importModule = vi.fn(async () => {
      if (kind === 'dependency') throw missing()
      if (kind === 'evaluation') throw new Error('模块执行失败')
      return { default: 42 }
    })
    await expect(createPluginResolver(resolveModule, importModule)('example')).rejects.toThrow()
    expect(resolveModule).toHaveBeenCalledOnce()
    expect(importModule).toHaveBeenCalledOnce()
  })
})
