import { expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Page } from '@antarestra/playwright'
import { readDom, render } from '../../plugins/features/web-tools/src/dom.js'
import { errorResult } from '../../plugins/features/web-tools/src/common.js'

it('主页面采集异常明确返回读取错误，保留诊断原因', async () => {
  const main = { evaluate: vi.fn().mockRejectedValue(new Error('__name is not defined')) }
  const page = { frames: () => [main], mainFrame: () => main } as unknown as Page
  const result = await readDom(page, 'test').catch(errorResult)
  expect(result).toEqual({
    isError: true,
    content: { error: 'page_read_failed', message: '主页面正文读取失败：__name is not defined' },
  })
})

it('子框架读取失败保留主页面正文，并报告局部读取原因', async () => {
  const main = {
    evaluate: vi.fn().mockResolvedValue([
      {
        ref: 'main:e1',
        parent: null,
        role: 'text',
        name: '',
        text: '主页面正文',
        hidden: false,
        main: true,
        interactive: false,
        state: '',
        href: '',
      },
    ]),
  }
  const child = { evaluate: vi.fn().mockRejectedValue(new Error('框架已分离')) }
  const page = {
    frames: () => [main, child],
    mainFrame: () => main,
    ariaSnapshot: async () => '- main: 主页面正文',
  } as unknown as Page
  const snapshot = await readDom(page, 'test')
  expect(render(snapshot, 'main')).toContain('主页面正文')
  expect(snapshot.warnings).toEqual(['子框架无法读取，搜索不包含该区域：框架已分离'])
  expect(snapshot.frames.get('main:e1')).toBe(main)
})

it('成功读取的空白页面仍允许返回空正文', async () => {
  const main = { evaluate: vi.fn().mockResolvedValue([]) }
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    ariaSnapshot: async () => '',
  } as unknown as Page
  const snapshot = await readDom(page, 'test')
  expect(render(snapshot, 'main')).toBe('')
  expect(snapshot.warnings).toEqual([])
})

it('Playwright 原生快照失败明确报错，不将其伪装成空正文', async () => {
  const main = { evaluate: vi.fn().mockResolvedValue([]) }
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    ariaSnapshot: vi.fn().mockRejectedValue(new Error('页面已关闭')),
  } as unknown as Page
  const result = await readDom(page, 'test').catch(errorResult)
  expect(result).toMatchObject({
    isError: true,
    content: {
      error: 'page_read_failed',
      message: 'Playwright 快照读取失败：页面已关闭',
    },
  })
})

it.skipIf(process.env.WEB_BROWSER_TEST !== '1')(
  '真实 tsx 开发运行器：网页脚本序列化、自动快照与交互',
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=development',
        fileURLToPath(new URL('../../scripts/smoke-web-tools.ts', import.meta.url)),
      ],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 30000 },
    )
    expect(stdout).toContain('网页工具验证通过')
  },
  35000,
)
