import { Service, browserUserAgent } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { chromium } from 'playwright-core'
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from 'playwright-core'
export type { Page, Dialog, ElementHandle, Locator, Frame } from 'playwright-core'

export interface Config {
  userAgent?: string
  executablePath?: string
  channel?: string
  headless?: boolean
  args?: string[]
  timeout?: number
  actionTimeout?: number
  proxy?: LaunchOptions['proxy']
  context?: Pick<
    BrowserContextOptions,
    | 'viewport'
    | 'deviceScaleFactor'
    | 'isMobile'
    | 'hasTouch'
    | 'ignoreHTTPSErrors'
    | 'locale'
    | 'timezoneId'
    | 'userAgent'
  >
}
export interface PageHandle {
  page: Page
  /** 关闭整个隔离上下文及其弹窗，可重复调用。 */
  close(): Promise<void>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    playwright: PlaywrightService
  }
}
export class PlaywrightService extends Service {
  private browser: Browser | undefined
  private launching: Promise<Browser> | undefined
  private disposed = false

  constructor(
    ctx: Context,
    private config: Config,
  ) {
    super(ctx, 'playwright')
    ctx.effect(() => async () => {
      this.disposed = true
      const browser = this.browser ?? (await this.launching?.catch(() => undefined))
      await browser?.close()
      this.browser = undefined
    })
  }

  private assertAvailable() {
    if (this.disposed) throw new Error('浏览器服务已卸载')
    this.ctx.fiber.assertActive()
  }

  private getBrowser(): Promise<Browser> {
    this.assertAvailable()
    if (this.browser?.isConnected()) return Promise.resolve(this.browser)
    if (this.launching) return this.launching
    const launch = async () => {
      const { executablePath, channel, headless, args, timeout, proxy } = this.config
      this.assertAvailable()
      const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        ...(channel ? { channel } : executablePath ? {} : { channel: 'chrome' }),
        headless: headless ?? true,
        ...(args ? { args } : {}),
        ...(timeout ? { timeout } : {}),
        ...(proxy ? { proxy } : {}),
      })
      if (this.disposed) {
        await browser.close()
        throw new Error('浏览器服务已卸载')
      }
      this.browser = browser
      browser.once('disconnected', () => {
        if (this.browser === browser) this.browser = undefined
      })
      return browser
    }
    this.launching = launch().finally(() => {
      this.launching = undefined
    })
    return this.launching
  }

  async createPage(owner: Context): Promise<PageHandle> {
    owner.fiber.assertActive()
    this.assertAvailable()
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let canceled = false
    let closing: Promise<void> | undefined
    let opening: Promise<Page>
    // 在任何异步等待前登记归属，防止调用方重载期间创建的页面逃过回收。
    const release = owner.effect(() => () => {
      canceled = true
      closing ??= (async () => {
        await opening.catch(() => undefined)
        if (browser?.isConnected()) await context?.close()
      })()
      return closing
    })
    const assertActive = () => {
      if (canceled) throw new Error('浏览器页面调用方已卸载或关闭')
      owner.fiber.assertActive()
      this.assertAvailable()
    }
    opening = (async () => {
      browser = await this.getBrowser()
      assertActive()
      let userAgent = this.config.context?.userAgent ?? this.config.userAgent
      if (userAgent === undefined) {
        const session = await browser.newBrowserCDPSession()
        try {
          const info = await session.send('Browser.getVersion')
          userAgent = browserUserAgent(info.userAgent, info.product)
        } finally {
          await session.detach()
        }
        assertActive()
      }
      context = await browser.newContext({
        ...this.config.context,
        userAgent,
      })
      context.setDefaultTimeout(this.config.actionTimeout ?? 10000)
      assertActive()
      const page = await context.newPage()
      assertActive()
      return page
    })()
    const close = async () => {
      await release()
      await closing
    }
    try {
      const page = await opening
      assertActive()
      return { page, close }
    } catch (error) {
      await close()
      throw error
    }
  }

  async withPage<T>(owner: Context, action: (page: Page) => Promise<T>): Promise<T> {
    const handle = await this.createPage(owner)
    try {
      return await action(handle.page)
    } finally {
      await handle.close()
    }
  }
}
export const name = 'playwright'
export function apply(ctx: Context, input: Config = {}) {
  const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  new PlaywrightService(ctx, config)
}
