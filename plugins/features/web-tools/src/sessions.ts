import { randomUUID } from 'node:crypto'
import type { Context } from '@antarestra/plugin-sdk'
import type { Page, PageHandle, Dialog } from '@antarestra/playwright'
import type { RunContext } from '@antarestra/ai'
import type { Snapshot } from './dom.js'
import type { PdfDocument } from './pdf.js'
import { abortable, WebError } from './common.js'
import type { Config } from './common.js'

export interface BrowserPage {
  id: string
  page: Page
  key: string
  snapshot?: Snapshot
  pdf?: PdfDocument
  pdfUrl?: string
  dialog?: Dialog
  revision: number
  title?: string
  status?: number
  challenge?: boolean
  screenshot?: {
    id: string
    revision: number
    width: number
    height: number
    viewportWidth: number
    viewportHeight: number
    x: number
    y: number
    scrollX: number
    scrollY: number
    scale: number
    domVersion: number
  }
  slices: Map<string, { content: string; snapshotId: string }>
}
export interface Session {
  key: string
  workspaceId: string
  conversationId: string
  root: Promise<PageHandle>
  pages: Map<string, BrowserPage>
  pendingPages: Set<Promise<unknown>>
  tail: Promise<unknown>
  jobs: number
  touched: number
  closed: boolean
  controller: AbortController
  closing?: Promise<void>
}
export class Sessions {
  readonly entries = new Map<string, Session>()
  private disposed = false
  constructor(
    private ctx: Context,
    private config: Config,
  ) {
    const timer = setInterval(() => {
      for (const session of this.entries.values())
        if (!session.jobs && Date.now() - session.touched >= (config.idleMinutes ?? 30) * 60000)
          void this.close(session)
    }, 30000)
    timer.unref()
    ctx.on('ai/conversation', (conversation, deleted) => {
      if (deleted) {
        const session = this.entries.get(
          JSON.stringify([conversation.workspaceId, conversation.id]),
        )
        if (session) void this.close(session)
      }
    })
    ctx.effect(() => async () => {
      this.disposed = true
      clearInterval(timer)
      await Promise.all([...this.entries.values()].map((session) => this.close(session)))
    })
  }
  private add(session: Session, page: Page) {
    const existing = [...session.pages.values()].find((item) => item.page === page)
    if (existing) return existing
    const record: BrowserPage = {
      id: randomUUID(),
      page,
      key: '__web_' + randomUUID().replaceAll('-', ''),
      revision: 0,
      slices: new Map(),
    }
    session.pages.set(record.id, record)
    page.on('response', (response) => {
      // 只跟踪主文档最终响应；子资源、iframe 和重定向中间响应不代表当前页面。
      if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return
      const status = response.status()
      if (status >= 300 && status < 400) return
      record.status = status
      record.challenge = response.headers()['cf-mitigated'] === 'challenge'
    })
    page.on('framenavigated', (frame) => {
      record.revision++
      if (frame === page.mainFrame()) delete record.snapshot
      delete record.screenshot
      record.slices.clear()
    })
    page.on('dialog', (dialog) => {
      record.dialog = dialog
    })
    page.on('close', () => {
      session.pages.delete(record.id)
      void record.pdf?.close()
    })
    return record
  }
  async newPage(session: Session) {
    if (session.pages.size >= (this.config.maxPages ?? 8))
      throw new WebError('page_limit', '页面数量达到上限，请先关闭不再使用的页面')
    const root = await session.root
    const page = await root.page.context().newPage()
    return this.add(session, page)
  }
  private create(context: RunContext) {
    if (this.disposed) throw new WebError('session_expired', '网页插件已卸载')
    const key = JSON.stringify([context.workspaceId, context.conversationId])
    const existing = this.entries.get(key)
    if (existing && !existing.closed) return existing
    if (this.entries.size >= (this.config.maxSessions ?? 16)) {
      const idle = [...this.entries.values()]
        .filter((session) => !session.jobs)
        .sort((a, b) => a.touched - b.touched)[0]
      if (!idle) throw new WebError('session_limit', '浏览器会话繁忙，请稍后重试')
      void this.close(idle)
    }
    const session: Session = {
      key,
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      root: this.ctx.playwright.createPage(this.ctx),
      pages: new Map(),
      pendingPages: new Set(),
      tail: Promise.resolve(),
      jobs: 0,
      touched: Date.now(),
      closed: false,
      controller: new AbortController(),
    }
    this.entries.set(key, session)
    session.root = session.root.then((handle) => {
      this.add(session, handle.page)
      const browser = handle.page.context().browser()!
      const disconnected = () => {
        void this.close(session)
      }
      browser.once('disconnected', disconnected)
      const browserContext = handle.page.context()
      const created = (page: Page) => {
        const pending = (async () => {
          if (session.closed || session.pages.size >= (this.config.maxPages ?? 8)) {
            await page.close()
            return
          }
          this.add(session, page)
        })()
        session.pendingPages.add(pending)
        void pending.finally(() => session.pendingPages.delete(pending)).catch(() => {})
      }
      browserContext.on('page', created)
      const close = handle.close
      handle.close = async () => {
        browser.off('disconnected', disconnected)
        browserContext.off('page', created)
        await close()
      }
      return handle
    })
    void session.root.catch(() => this.close(session))
    return session
  }
  async close(session: Session): Promise<void> {
    if (session.closing) return session.closing
    session.closed = true
    session.controller.abort(new WebError('session_expired', '浏览器会话已失效，请重新打开页面'))
    if (this.entries.get(session.key) === session) this.entries.delete(session.key)
    session.closing = (async () => {
      const handle = await session.root.catch(() => undefined)
      await Promise.allSettled([...session.pages.values()].map((page) => page.pdf?.close()))
      await handle?.close().catch(() => {})
      session.pages.clear()
    })()
    return session.closing
  }
  async run<T>(
    context: RunContext,
    action: (session: Session, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    context.signal.throwIfAborted()
    const session = this.create(context)
    const queued = Date.now()
    session.jobs++
    const task = session.tail
      .then(async () => {
        context.signal.throwIfAborted()
        if (session.closed)
          throw new WebError('session_expired', '浏览器会话已失效，请重新打开页面')
        const signal = AbortSignal.any([
          context.signal,
          session.controller.signal,
          AbortSignal.timeout(this.config.timeoutMs ?? 60000),
        ])
        const cancel = () => {
          void this.close(session)
        }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          await abortable(session.root, signal)
          this.ctx.logger.debug(
            '浏览器排队 %d ms，页面 %d',
            Date.now() - queued,
            session.pages.size,
          )
          return await abortable(action(session, signal), signal)
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      })
      .finally(() => {
        session.jobs--
        session.touched = Date.now()
      })
    session.tail = task.catch(() => {})
    return abortable(task, context.signal)
  }
  page(session: Session, id: unknown) {
    const page = session.pages.get(String(id))
    if (!page || page.page.isClosed())
      throw new WebError('page_expired', '页面不存在或已关闭，请重新打开 URL')
    return page
  }
}
