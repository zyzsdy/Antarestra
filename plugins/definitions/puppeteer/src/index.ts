import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import puppeteer from 'puppeteer-core'
import type {
  Browser,
  BrowserContext,
  Page,
  GoToOptions,
  ScreenshotOptions,
  Viewport,
  SetContentWaitForOptions,
} from 'puppeteer-core'
import { findExecutable } from './executable.js'

export type {
  Dialog,
  Target,
  ElementHandle,
  KeyInput,
  Page,
  GoToOptions,
  ScreenshotOptions,
  Viewport,
  SetContentWaitForOptions,
} from 'puppeteer-core'
export interface Config {
  executablePath?: string
  headless?: boolean
  args?: string[]
  timeout?: number
  protocolTimeout?: number
  defaultViewport?: Viewport
  acceptInsecureCerts?: boolean
}
export interface PageHandle {
  page: Page
  /** 关闭整个隔离上下文及其弹窗，可重复调用。 */
  close(): Promise<void>
}
export interface ReadResult {
  url: string
  title: string
  text: string
  html: string
  status: number | null
}
export interface RenderOptions {
  viewport?: Viewport
  wait?: SetContentWaitForOptions
  screenshot?: Omit<ScreenshotOptions, 'path' | 'encoding'>
}

declare module '@antarestra/plugin-sdk' {
  interface Context {
    puppeteer: PuppeteerService
  }
}

export class PuppeteerService extends Service {
  private browser: Browser | undefined
  private launching: Promise<Browser> | undefined
  private disposed = false

  constructor(
    ctx: Context,
    private config: Config,
  ) {
    super(ctx, 'puppeteer')
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
    if (this.browser?.connected) return Promise.resolve(this.browser)
    if (this.launching) return this.launching
    const launch = async () => {
      const executablePath = await findExecutable(this.config.executablePath)
      this.assertAvailable()
      const browser = await puppeteer.launch({
        ...this.config,
        executablePath,
        headless: this.config.headless ?? true,
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
        if (browser?.connected) await context?.close()
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
      context = await browser.createBrowserContext()
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

  read(owner: Context, url: string, options?: GoToOptions): Promise<ReadResult> {
    return this.withPage(owner, async (page) => {
      const response = await page.goto(url, options)
      return {
        url: page.url(),
        title: await page.title(),
        text: await page.$eval('body', (body) => (body as HTMLElement).innerText),
        html: await page.content(),
        status: response?.status() ?? null,
      }
    })
  }

  screenshot(owner: Context, html: string, options: RenderOptions = {}): Promise<Buffer> {
    return this.withPage(owner, async (page) => {
      if (options.viewport) await page.setViewport(options.viewport)
      await page.setContent(html, options.wait)
      const data = await page.screenshot({
        type: 'png',
        fullPage: true,
        ...options.screenshot,
        encoding: 'binary',
      })
      return Buffer.from(data)
    })
  }
}

export const name = 'puppeteer'
export function apply(ctx: Context, input: Config = {}) {
  const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  new PuppeteerService(ctx, config)
}
