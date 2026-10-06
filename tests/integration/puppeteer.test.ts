import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import * as plugin from '@antarestra/puppeteer'
import type { Page } from '@antarestra/puppeteer'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const nativeUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36'

const mock = vi.hoisted(() => ({ launch: vi.fn(), executable: vi.fn() }))
vi.mock('../../plugins/definitions/puppeteer/node_modules/puppeteer-core', () => ({
  default: { launch: mock.launch },
}))
vi.mock('../../plugins/definitions/puppeteer/src/executable.js', () => ({
  findExecutable: mock.executable,
}))
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.resetAllMocks()
})
function browserMock() {
  const page = { marker: true, setUserAgent: vi.fn(async () => {}) } as unknown as Page
  const scopes: { close: ReturnType<typeof vi.fn>; newPage: ReturnType<typeof vi.fn> }[] = []
  const browser = {
    connected: true,
    close: vi.fn(async () => {
      browser.connected = false
    }),
    once: vi.fn(),
    userAgent: vi.fn(async () => nativeUserAgent),
    version: vi.fn(async () => 'HeadlessChrome/154.0.8123.42'),
    createBrowserContext: vi.fn(async () => {
      const scope = { close: vi.fn(async () => {}), newPage: vi.fn(async () => page) }
      scopes.push(scope)
      return scope
    }),
  }
  mock.executable.mockResolvedValue('测试浏览器')
  mock.launch.mockResolvedValue(browser)
  return { browser, scopes, page }
}
async function setup(config: plugin.Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(plugin, config)
  return { ctx, fiber }
}

describe('浏览器生命周期', () => {
  it.each([
    [
      {},
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8123.42 Safari/537.36 Anta/${version}`,
    ],
    [{ userAgent: 'Custom/1.0' }, 'Custom/1.0'],
  ] satisfies [plugin.Config, string][])(
    '在交给调用方前设置默认或自定义 User-Agent：%j',
    async (config, expected) => {
      const { page } = browserMock()
      const { ctx } = await setup(config)
      await ctx.puppeteer.withPage(ctx, async (value) => {
        expect(value.setUserAgent).toHaveBeenCalledWith({ userAgent: expected })
      })
      expect(mock.launch.mock.calls[0]?.[0]).not.toHaveProperty('userAgent')
      expect(page.setUserAgent).toHaveBeenCalledTimes(1)
    },
  )

  it('设置 User-Agent 失败时回收上下文，不调用页面操作', async () => {
    const { page, scopes } = browserMock()
    vi.mocked(page.setUserAgent).mockRejectedValueOnce(new Error('设置失败'))
    const { ctx } = await setup()
    const action = vi.fn()
    await expect(ctx.puppeteer.withPage(ctx, action)).rejects.toThrow('设置失败')
    expect(action).not.toHaveBeenCalled()
    expect(scopes[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('按需单次启动，并发操作隔离页面并透传启动配置', async () => {
    const { browser, scopes, page } = browserMock()
    const { ctx, fiber } = await setup({ executablePath: '测试路径', args: ['--lang=zh-CN'] })
    expect(mock.launch).not.toHaveBeenCalled()
    await Promise.all([
      ctx.puppeteer.withPage(ctx, async (value) => expect(value).toBe(page)),
      ctx.puppeteer.withPage(ctx, async () => {}),
    ])
    expect(mock.launch).toHaveBeenCalledTimes(1)
    expect(mock.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: '测试浏览器',
        headless: true,
        args: ['--lang=zh-CN'],
      }),
    )
    expect(scopes).toHaveLength(2)
    for (const scope of scopes) expect(scope.close).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('操作异常、主动关闭和调用方卸载均回收上下文', async () => {
    const { scopes } = browserMock()
    const { ctx } = await setup()
    await expect(
      ctx.puppeteer.withPage(ctx, async () => {
        throw new Error('操作失败')
      }),
    ).rejects.toThrow('操作失败')
    let handle!: plugin.PageHandle
    const consumer = await ctx.plugin({
      inject: ['puppeteer'],
      async apply(owner: Context) {
        handle = await owner.puppeteer.createPage(owner)
      },
    })
    await consumer.dispose()
    await handle.close()
    expect(scopes.map((scope) => scope.close.mock.calls.length)).toEqual([1, 1])
  })

  it('启动失败允许重试，浏览器断开后重新启动', async () => {
    const { browser } = browserMock()
    mock.launch.mockRejectedValueOnce(new Error('启动失败'))
    const { ctx } = await setup()
    await expect(ctx.puppeteer.withPage(ctx, async () => {})).rejects.toThrow('启动失败')
    await ctx.puppeteer.withPage(ctx, async () => {})
    browser.connected = false
    await ctx.puppeteer.withPage(ctx, async () => {})
    expect(mock.launch).toHaveBeenCalledTimes(3)
  })

  it('启动过程中卸载也会等待并关闭浏览器', async () => {
    const { browser } = browserMock()
    let started!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: (value: typeof browser) => void
    mock.launch.mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const { ctx, fiber } = await setup()
    const result = expect(ctx.puppeteer.withPage(ctx, async () => {})).rejects.toThrow('已卸载')
    await starting
    const disposing = fiber.dispose()
    finish(browser)
    await disposing
    await result
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('依赖服务重新加载后消费者恢复，并拒绝失效服务引用', async () => {
    browserMock()
    const { ctx, fiber } = await setup()
    const old = ctx.puppeteer
    let starts = 0
    const consumer = await ctx.plugin({
      inject: ['puppeteer'],
      apply() {
        starts++
      },
    })
    await fiber.dispose()
    await expect(old.createPage(ctx)).rejects.toThrow('已卸载')
    await ctx.plugin(plugin)
    await consumer.await()
    expect(starts).toBe(2)
  })

  it('拒绝错误启动配置', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(plugin, { args: '无效' } as never)).rejects.toThrow('配置校验失败')
  })

  it('页面创建过程中卸载调用方会等待并回收迟到的上下文', async () => {
    const { browser, page } = browserMock()
    let finish!: (scope: Awaited<ReturnType<typeof browser.createBrowserContext>>) => void
    let started!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    browser.createBrowserContext.mockImplementation(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const { ctx } = await setup()
    let pending!: Promise<unknown>
    const consumer = await ctx.plugin({
      inject: ['puppeteer'],
      apply(owner: Context) {
        pending = expect(owner.puppeteer.createPage(owner)).rejects.toThrow('已卸载')
      },
    })
    await starting
    const disposing = consumer.dispose()
    const scope = { close: vi.fn(async () => {}), newPage: vi.fn(async () => page) }
    finish(scope)
    await disposing
    await pending
    expect(scope.newPage).not.toHaveBeenCalled()
    expect(scope.close).toHaveBeenCalledTimes(1)
    expect(browser.close).not.toHaveBeenCalled()
  })
})
