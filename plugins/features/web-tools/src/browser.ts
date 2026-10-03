import { randomUUID } from 'node:crypto'
import type { Context } from '@antarestra/plugin-sdk'
import type { JsonObject, RunContext, StructuredToolResult } from '@antarestra/ai'
import { readDom, render, target } from './dom.js'
import { Sessions } from './sessions.js'
import type { BrowserPage, Session } from './sessions.js'
import { perform } from './actions.js'
import { PdfDocument } from './pdf.js'
import { abortable, asJson, errorResult, sourceId, urlValue, WebError } from './common.js'
import type { Config } from './common.js'

export class BrowserTools {
  readonly sessions: Sessions
  constructor(
    private ctx: Context,
    private config: Config,
  ) {
    this.sessions = new Sessions(ctx, config)
  }
  private async navigation<T>(record: BrowserPage, operation: () => Promise<T>) {
    let stop: (() => void) | undefined
    const dialog = new Promise<undefined>((resolve) => {
      const handler = () => resolve(undefined)
      record.page.once('dialog', handler)
      stop = () => record.page.off('dialog', handler)
    })
    try {
      return await Promise.race([operation(), dialog])
    } finally {
      stop?.()
    }
  }
  private async settle(record: BrowserPage) {
    if (record.dialog || record.pdf || record.page.isClosed()) return
    await this.navigation(record, () =>
      record.page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let quiet: ReturnType<typeof setTimeout>
            // 对象方法可独立序列化，不依赖 tsx 在宿主环境注入的函数命名辅助代码。
            const { done } = {
              done() {
                clearTimeout(deadline)
                clearTimeout(quiet)
                observer.disconnect()
                resolve()
              },
            }
            const observer = new MutationObserver(() => {
              clearTimeout(quiet)
              quiet = setTimeout(done, 150)
            })
            const deadline = setTimeout(done, 500)
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            })
            quiet = setTimeout(done, 150)
          }),
      ),
    ).catch(() => {})
  }
  private metadata(record: BrowserPage) {
    const url = record.pdfUrl ?? record.page.url()
    return {
      pageId: record.id,
      url,
      title: record.title ?? '',
      status: record.status ?? null,
      sourceId: sourceId(url),
      fetchedAt: new Date().toISOString(),
      contentType: record.pdf ? 'pdf' : 'page',
      untrusted: true,
    }
  }
  private async snapshot(record: BrowserPage, args: JsonObject = {}) {
    const view = String(args.view ?? 'combined')
    if (record.dialog) {
      const content = record.snapshot ? render(record.snapshot, view) : ''
      const max = this.config.maxCharacters ?? 24000
      return {
        ...this.metadata(record),
        snapshotId: record.snapshot?.id ?? null,
        title: '页面等待对话框响应',
        content: content.slice(0, max),
        truncated: content.length > max,
        snapshotStale: true,
        dialog: {
          type: record.dialog.type(),
          message: record.dialog.message(),
          defaultValue: record.dialog.defaultValue(),
        },
      }
    }
    let content: string,
      snapshotId: string,
      offset = 0
    if (typeof args.cursor === 'string') {
      const [key, start] = args.cursor.split('/')
      const cached = record.slices.get(key!)
      offset = Number(start)
      if (!cached || !Number.isSafeInteger(offset) || offset < 0 || offset > cached.content.length)
        throw new WebError('stale_cursor', '内容游标已过期，请重新读取页面')
      content = cached.content
      snapshotId = cached.snapshotId
    } else {
      if (record.pdf) {
        const page = args.pdfPage === undefined ? undefined : Number(args.pdfPage)
        if (page !== undefined && (page < 1 || page > record.pdf.texts.length))
          throw new WebError('invalid_pdf_page', 'PDF 页码超出范围')
        content = record.pdf.texts
          .flatMap((text, index) =>
            page === undefined || page === index + 1
              ? [`第 ${index + 1} 页\n${text || '[此页无文本层，可调用截图查看]'} `]
              : [],
          )
          .join('\n')
        snapshotId = randomUUID()
      } else {
        record.snapshot = await readDom(record.page, record.key)
        snapshotId = record.snapshot.id
        content = render(record.snapshot, view, typeof args.ref === 'string' ? args.ref : undefined)
      }
      record.slices.clear()
      record.slices.set(snapshotId, { content, snapshotId })
    }
    const budget = Math.min(
      Number(args.maxCharacters ?? this.config.maxCharacters ?? 24000),
      this.config.maxCharacters ?? 24000,
    )
    const end = Math.min(content.length, offset + budget)
    record.title = record.pdf
      ? new URL(record.pdfUrl!).pathname.split('/').at(-1) || 'PDF 文档'
      : await record.page.title()
    const notices = []
    if (/captcha|verify you are human|人机验证|验证码/i.test(content.slice(0, 6000)))
      notices.push({ code: 'verification_required', message: '页面包含验证提示，可能需要人工处理' })
    if (content.includes('value=[密码已隐藏]'))
      notices.push({ code: 'login_required', message: '页面包含密码输入框，所需内容可能要求登录' })
    if (record.status && record.status >= 400)
      notices.push({ code: 'http_error', message: `页面返回 HTTP ${record.status}` })
    this.ctx.logger.debug('网页内容：返回 %d 字符，总计 %d 字符', end - offset, content.length)
    return {
      ...this.metadata(record),
      snapshotId,
      content: content.slice(offset, end),
      offset,
      totalCharacters: content.length,
      truncated: end < content.length,
      nextCursor: end < content.length ? `${snapshotId}/${end}` : null,
      pageCount: record.pdf?.texts.length ?? null,
      notices,
      warnings: record.snapshot?.warnings ?? [],
      coverage: '仅当前已加载文本；不含尚未加载的分页、图片文字和封闭 Shadow DOM',
    }
  }
  private list(session: Session) {
    return [...session.pages.values()].map((record) => ({
      ...this.metadata(record),
      pdf: !!record.pdf,
    }))
  }
  private async loadPdf(record: BrowserPage, url: string, signal: AbortSignal) {
    const response = await this.ctx.http(url, { signal, proxyAgent: '', redirect: 'follow' })
    if (!response.ok) {
      await response.body?.cancel()
      throw new WebError('navigation_failed', `文档返回 HTTP ${response.status}`)
    }
    if (!response.headers.get('content-type')?.includes('application/pdf')) {
      await response.body?.cancel()
      throw new WebError('not_pdf', '目标不是 PDF 文档')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new WebError('empty_document', '文档响应为空')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > 32 * 1024 ** 2) throw new WebError('pdf_too_large', 'PDF 超过 32 MiB')
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const loading = PdfDocument.open(Buffer.concat(chunks))
    const cleanup = () => {
      void loading.then((pdf) => pdf.close()).catch(() => {})
    }
    signal.addEventListener('abort', cleanup, { once: true })
    try {
      record.pdf = await abortable(loading, signal)
      record.pdfUrl = response.url || url
      record.status = response.status
    } finally {
      signal.removeEventListener('abort', cleanup)
    }
  }
  private async open(session: Session, args: JsonObject, signal: AbortSignal) {
    const action = String(args.action ?? 'open')
    if (action === 'list') return { pages: this.list(session) }
    let record: BrowserPage
    if (args.pageId) record = this.sessions.page(session, args.pageId)
    else if (action === 'open') {
      record =
        [...session.pages.values()].find(
          (item) => item.page.url() === 'about:blank' && !item.pdf,
        ) ?? (await this.sessions.newPage(session))
    } else throw new WebError('missing_page', '此操作需要 pageId')
    if (action === 'close') {
      await record.pdf?.close()
      delete record.pdf
      await record.page.close()
      return { pages: this.list(session) }
    }
    if (record.dialog) throw new WebError('dialog_pending', '请先处理网页对话框')
    if (action === 'open') {
      const url = urlValue(args.url)
      await record.pdf?.close()
      delete record.pdf
      delete record.pdfUrl
      record.slices.clear()
      delete record.snapshot
      delete record.screenshot
      if (/\.pdf(?:$|[?#])/i.test(url)) await this.loadPdf(record, url, signal)
      else {
        try {
          const response = await this.navigation(record, () =>
            record.page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: this.config.timeoutMs ?? 60000,
            }),
          )
          if (response) record.status = response.status()
          if (response?.headers()['content-type']?.includes('application/pdf'))
            await this.loadPdf(record, response.url(), signal)
        } catch (error) {
          signal.throwIfAborted()
          try {
            await this.loadPdf(record, url, signal)
          } catch {
            throw error
          }
        }
      }
    } else if (record.pdf) {
      if (action !== 'reload') throw new WebError('document_readonly', 'PDF 不支持浏览历史导航')
      const url = record.pdfUrl!
      await record.pdf.close()
      delete record.pdf
      await this.loadPdf(record, url, signal)
    } else if (action === 'back')
      await this.navigation(record, () => record.page.goBack({ waitUntil: 'domcontentloaded' }))
    else if (action === 'forward')
      await this.navigation(record, () => record.page.goForward({ waitUntil: 'domcontentloaded' }))
    else if (action === 'reload')
      await this.navigation(record, () => record.page.reload({ waitUntil: 'domcontentloaded' }))
    else throw new WebError('invalid_action', '未知页面操作')
    await this.settle(record)
    return { ...(await this.snapshot(record, args)), pages: this.list(session) }
  }
  private async find(record: BrowserPage, args: JsonObject) {
    if (record.dialog) return this.snapshot(record)
    if (!record.pdf) record.snapshot = await readDom(record.page, record.key)
    const entries = record.pdf
      ? record.pdf.texts.map((text, index) => ({
          text,
          ref: null,
          hidden: false,
          pdfPage: index + 1,
        }))
      : record
          .snapshot!.entries.filter((item) => args.includeHidden || !item.hidden)
          .map((item) => ({
            text: item.text || item.name,
            ref: item.ref,
            hidden: item.hidden,
            pdfPage: null,
          }))
    const spans: {
      start: number
      end: number
      ref: string | null
      hidden: boolean
      pdfPage: number | null
    }[] = []
    let text = ''
    for (const entry of entries) {
      spans.push({
        start: text.length,
        end: text.length + entry.text.length,
        ref: entry.ref,
        hidden: entry.hidden,
        pdfPage: entry.pdfPage,
      })
      text += entry.text + '\n'
    }
    const haystack = args.caseSensitive ? text : text.toLocaleLowerCase()
    const needle = args.caseSensitive ? String(args.text) : String(args.text).toLocaleLowerCase()
    if (!needle) throw new WebError('empty_search', '查找文本不能为空')
    const matches = []
    let position = 0,
      count = 0
    const offset = Number(args.offset ?? 0),
      limit = Number(args.limit ?? 20)
    while ((position = haystack.indexOf(needle, position)) >= 0) {
      if (count >= offset && matches.length < limit) {
        const span = spans.find((item) => item.end >= position)
        matches.push({
          position,
          ref: span?.ref ?? null,
          hidden: span?.hidden ?? false,
          pdfPage: span?.pdfPage ?? null,
          context: text.slice(Math.max(0, position - 120), position + needle.length + 160),
        })
      }
      count++
      position += needle.length
    }
    return {
      ...this.metadata(record),
      snapshotId: record.snapshot?.id ?? null,
      matches,
      total: count,
      nextOffset: offset + matches.length < count ? offset + matches.length : null,
      warnings: record.snapshot?.warnings ?? [],
      coverage: '搜索完整已加载文本索引，包含视口外内容；不包含尚未加载内容及图片文字',
    }
  }
  private async interact(
    session: Session,
    record: BrowserPage,
    args: JsonObject,
    signal: AbortSignal,
    progress: { results: JsonObject[]; page?: JsonObject },
  ): Promise<StructuredToolResult> {
    await record.page.bringToFront()
    const steps = args.actions as JsonObject[]
    const results = progress.results
    progress.page = { ...this.metadata(record), snapshotStale: true }
    let failed = false,
      stopped = false
    const beforePages = new Set(session.pages.keys())
    for (let index = 0; index < steps.length; index++) {
      if (stopped) {
        results.push({ index, status: 'not_executed' })
        continue
      }
      const revision = record.revision
      results.push({ index, status: 'uncertain' })
      try {
        signal.throwIfAborted()
        const running = perform(record, steps[index]!)
        // 点击可能被同步 alert 阻塞；对话框出现时先交还控制权，不等待截图。
        let off: (() => void) | undefined
        const dialog = new Promise<'dialog'>((resolve) => {
          const handler = () => resolve('dialog')
          record.page.once('dialog', handler)
          off = () => record.page.off('dialog', handler)
        })
        let outcome: void | 'dialog'
        try {
          outcome = await Promise.race([running, dialog])
        } finally {
          off?.()
        }
        if (outcome === 'dialog') void running.catch(() => {})
        await this.settle(record)
        await Promise.allSettled([...session.pendingPages])
        results[index] = { index, status: 'completed' }
        if (!['move', 'mouse_down', 'key_down', 'wait'].includes(String(steps[index]!.type)))
          delete record.screenshot
        if (
          record.dialog ||
          revision !== record.revision ||
          [...session.pages.keys()].some((id) => !beforePages.has(id))
        )
          stopped = true
      } catch (error) {
        signal.throwIfAborted()
        results[index] = { index, status: 'failed', ...(errorResult(error).content as JsonObject) }
        failed = true
        stopped = true
      }
    }
    let snapshot: unknown
    try {
      snapshot = await this.snapshot(record)
    } catch {
      snapshot = {
        ...this.metadata(record),
        error: 'snapshot_unavailable',
        message: '操作后页面不可读取',
      }
    }
    return {
      isError: failed,
      content: asJson({ results, stopped, page: snapshot, pages: this.list(session) }),
    }
  }
  private async screenshot(
    record: BrowserPage,
    args: JsonObject,
    context: RunContext,
    signal: AbortSignal,
  ) {
    if (record.dialog) throw new WebError('dialog_pending', '请先处理对话框再截图')
    let image: { data: Uint8Array; width: number; height: number }
    if (record.pdf) image = await record.pdf.screenshot(Number(args.pdfPage ?? 1))
    else {
      const viewport = await record.page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        x: scrollX,
        y: scrollY,
        total: document.documentElement.scrollHeight,
      }))
      if (args.fullPage && viewport.width * viewport.total > 24_000_000)
        throw new WebError('screenshot_too_large', '整页过大，请使用视口或元素截图')
      const element = args.ref
        ? await target(record.snapshot, String(args.ref), record.key)
        : undefined
      let x = 0,
        y = 0
      try {
        if (element) {
          await element.scrollIntoView()
          const box = await element.boundingBox()
          x = box?.x ?? 0
          y = box?.y ?? 0
        }
        const bytes = element
          ? await element.screenshot({ type: 'png' })
          : await record.page.screenshot({ type: 'png', fullPage: args.fullPage === true })
        const data = Buffer.from(bytes)
        image = { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
        const after = await record.page.evaluate(() => ({
          x: scrollX,
          y: scrollY,
          width: innerWidth,
          height: innerHeight,
        }))
        const cssWidth = element
          ? ((await element.boundingBox())?.width ?? after.width)
          : after.width
        const domVersion = await record.page.evaluate(
          (key) =>
            (globalThis as unknown as Record<string, { version: number }>)[key]?.version ?? 0,
          record.key,
        )
        record.screenshot = {
          id: randomUUID(),
          revision: record.revision,
          width: image.width,
          height: image.height,
          viewportWidth: after.width,
          viewportHeight: after.height,
          x: args.fullPage ? -after.x : x,
          y: args.fullPage ? -after.y : y,
          scrollX: after.x,
          scrollY: after.y,
          scale: image.width / cssWidth,
          domVersion,
        }
      } finally {
        await element?.dispose()
      }
    }
    if (image.data.byteLength > 8 * 1024 ** 2)
      throw new WebError('screenshot_too_large', '截图超过 8 MiB，请使用视口或元素截图')
    let stored
    try {
      stored = await this.ctx.ai.storeToolImage(context, {
        ...image,
        signal,
        mimeType: 'image/png',
        filename: `网页截图-${Date.now()}.png`,
      })
    } catch {
      signal.throwIfAborted()
      throw new WebError('storage_failed', '截图保存失败，请检查工作空间文件权限、配额与存储服务')
    }
    this.ctx.logger.debug('网页截图：%d 字节', image.data.byteLength)
    return {
      images: [stored],
      content: asJson({
        ...this.metadata(record),
        screenshot: record.screenshot ?? null,
        pdfPage: record.pdf ? (args.pdfPage ?? 1) : null,
      }),
    }
  }
  async execute(
    name: string,
    args: JsonObject,
    context: RunContext,
  ): Promise<StructuredToolResult> {
    const started = Date.now()
    const progress: { results: JsonObject[]; page?: JsonObject } = { results: [] }
    try {
      return await this.sessions.run(context, async (session, signal) => {
        if (name === 'web_open') return { content: asJson(await this.open(session, args, signal)) }
        const record = this.sessions.page(session, args.pageId)
        if (name === 'web_interact') return this.interact(session, record, args, signal, progress)
        if (name === 'web_screenshot') return this.screenshot(record, args, context, signal)
        if (name === 'web_find') return { content: asJson(await this.find(record, args)) }
        return { content: asJson(await this.snapshot(record, args)) }
      })
    } catch (error) {
      if (context.signal.aborted) throw error
      const result = errorResult(error)
      if (progress.page) {
        const actions = args.actions as JsonObject[]
        while (progress.results.length < actions.length)
          progress.results.push({ index: progress.results.length, status: 'not_executed' })
        result.content = {
          ...(result.content as JsonObject),
          ...progress,
          stopped: true,
          snapshotUnavailable: '操作被中断，浏览器上下文已关闭，请重新打开页面',
        }
      }
      return result
    } finally {
      this.ctx.logger.debug('网页工具 %s：%d ms', name, Date.now() - started)
    }
  }
}
