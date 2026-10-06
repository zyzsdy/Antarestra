import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { listenForTest } from '../../scripts/test-listen.js'
import { Context, Service } from '@antarestra/plugin-sdk'
import * as http from '@antarestra/http'
import * as playwright from '@antarestra/playwright'
import { BrowserTools } from '@antarestra/plugin-web-tools'
import type { GeneratedImage, RunContext, ToolImage } from '@antarestra/ai'
import { searchTool } from '../../plugins/features/web-tools/src/search.js'
import { PdfDocument } from '../../plugins/features/web-tools/src/pdf.js'
import {
  structuredResult,
  toolResultContent,
} from '../../plugins/definitions/ai/src/tool-results.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
function context(
  actorId = 'actor',
  workspaceId = 'space',
  signal = new AbortController().signal,
): RunContext {
  return {
    runId: 'run',
    conversationId: 'conversation',
    workspaceId,
    actorId,
    signal,
    agent: {
      id: 'agent',
      version: '1',
      title: '测试',
      backendId: 'test',
      systemTemplate: '',
      userTemplate: '',
      models: [],
      defaultModel: { providerId: 'p', modelId: 'm' },
      toolIds: [],
      skillIds: [],
      extensions: {},
    },
  }
}
const image: ToolImage = {
  type: 'image',
  resourceId: 'image',
  mimeType: 'image/png',
  filename: '测试.png',
  width: 10,
  height: 10,
  size: 20,
}
it.runIf(process.env.WEB_BROWSER_TEST === '1')(
  'HTML 文本和资源生成整页图片，保存模式仅返回资源 ID，并清理临时页面',
  async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const html =
      '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#eef}article{height:1400px}footer{height:100px;background:#f00}</style><article><h1>图文文档</h1><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22blue%22/%3E%3C/svg%3E"></article><footer>末尾证据</footer>'
    const writes: boolean[] = []
    class ImageSink extends Service {
      constructor() {
        super(ctx, 'ai')
      }
      async readToolResource(who: RunContext, id: string) {
        if (who.workspaceId !== 'space' || id !== 'html-file') throw new Error('拒绝跨空间资源')
        return {
          data: Buffer.from(html).toString('base64'),
          mimeType: 'text/html',
          filename: '文档.html',
        }
      }
      async storeToolImage(_who: RunContext, data: GeneratedImage, persist: boolean) {
        writes.push(persist)
        expect(data.height).toBeGreaterThanOrEqual(1500)
        expect(Buffer.from(data.data).readUInt32BE(20)).toBe(data.height)
        return {
          ...image,
          width: data.width,
          height: data.height,
          resourceId: persist ? 'saved-image' : 'ai-transient:test',
        }
      }
    }
    new ImageSink()
    await ctx.plugin(playwright, { context: { viewport: { width: 800, height: 600 } } })
    const observer = await ctx.playwright.createPage(ctx)
    const engine = observer.page.context().browser()!
    const baseline = engine.contexts().length
    const browser = new BrowserTools(ctx, { timeoutMs: 10000 })
    const result = await browser.execute('web_screenshot', { html }, context())
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.images?.[0]?.height).toBeGreaterThanOrEqual(1500)
    expect(writes).toEqual([false])
    const saved = await browser.execute(
      'web_screenshot',
      { resourceId: 'html-file', saveToWorkspace: true },
      context(),
    )
    expect(saved).toEqual({ content: { resourceId: 'saved-image' } })
    expect(writes).toEqual([false, true])
    expect(
      (
        await browser.execute(
          'web_screenshot',
          { resourceId: 'html-file' },
          context('actor', 'other'),
        )
      ).isError,
    ).toBe(true)
    expect(
      (await browser.execute('web_screenshot', { html, pageId: 'page' }, context())).isError,
    ).toBe(true)
    expect(
      (await browser.execute('web_screenshot', { html, fullPage: false }, context())).isError,
    ).toBe(true)
    expect(browser.sessions.entries.size).toBe(0)
    expect(engine.contexts().length).toBe(baseline)
    const oversized = await browser.execute(
      'web_screenshot',
      { html: '<div style="width:30000px;height:1000px">超宽内容</div>' },
      context(),
    )
    expect(oversized).toMatchObject({ isError: true, content: { error: 'screenshot_too_large' } })
    expect(engine.contexts().length).toBe(baseline)
    const server = createServer(() => {})
    await listenForTest(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('端口错误')
    try {
      const controller = new AbortController()
      const pending = browser.execute(
        'web_screenshot',
        { html: `<img src="http://127.0.0.1:${address.port}/pending">` },
        context('actor', 'space', controller.signal),
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      controller.abort()
      await expect(pending).rejects.toBeDefined()
      expect(engine.contexts().length).toBe(baseline)
      expect(writes).toEqual([false, true])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await observer.close()
    }
  },
  30000,
)
it('结构化结果校验与 Base64 图片内容转换保留调用对应内容', () => {
  expect(structuredResult({ content: { ok: true }, images: [image] }).images).toEqual([image])
  expect(() =>
    structuredResult({ content: '', images: [{ ...image, size: 9 * 1024 ** 2 }] }),
  ).toThrow()
  const block = {
    type: 'tool-result' as const,
    id: 'call',
    content: { ok: true },
    images: [image],
    isError: false,
  }
  expect(
    toolResultContent(
      block,
      new Map([['image', { data: 'YWJj', mimeType: 'image/png', filename: '测试.png' }]]),
    ),
  ).toEqual([
    { type: 'text', text: '{"ok":true}' },
    { type: 'image', data: 'YWJj', mimeType: 'image/png' },
  ])
  expect(toolResultContent(block, new Map())[1]).toMatchObject({ type: 'text' })
})
it('Serper 通过 HTTP 服务传递独立代理，筛选域名并保留部分查询错误', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(http)
  const requests: { url: string; proxy: unknown; body: unknown }[] = []
  ctx.on('http/fetch', async (url, init, config) => {
    requests.push({
      url: String(url),
      proxy: config.proxyAgent,
      body: JSON.parse(String(init.body)),
    })
    if (String(init.body).includes('失败')) return new Response('{}', { status: 429 })
    return new Response(
      JSON.stringify({
        organic: [
          { title: '文档', link: 'https://docs.example.com/a', snippet: '摘要' },
          { link: 'https://evil-example.com' },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  })
  const result = await searchTool(ctx, {
    apiKey: 'fixture-key',
    searchProxy: 'socks5://127.0.0.1:7890',
  })({ queries: ['资料', '失败'], domains: ['example.com'] }, context())
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result)).toContain('search_quota')
  expect(JSON.stringify(result)).not.toContain('evil-example')
  expect(requests[0]).toMatchObject({
    url: 'https://google.serper.dev/search',
    proxy: 'socks5://127.0.0.1:7890',
  })
  expect(JSON.stringify(requests[0]?.body)).toContain('site:example.com')
  expect(JSON.stringify(await searchTool(ctx, {})({ query: '资料' }, context()))).toContain(
    'missing_api_key',
  )
})

it.skipIf(process.env.WEB_BROWSER_TEST !== '1')(
  '真实浏览器：跨操作者共享、跨空间隔离、自动快照、全文查找、弹窗、截图与队列取消',
  async () => {
    let pdfBytes: Uint8Array | undefined
    const server = createServer((req, res) => {
      if (req.url === '/doc.pdf') {
        res.setHeader('content-type', 'application/pdf')
        res.end(pdfBytes)
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (req.url === '/frame') {
        res.end('<p>框架里的证据</p>')
        return
      }
      res.end(
        `<!doctype html><title>浏览器测试</title><nav>导航里的线索</nav><main><h1>正文</h1><label>关键词<input id="query"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#query').value">执行搜索</button><p id="result">初始内容</p><button onclick="alert('等待确认')">显示对话框</button><button onclick="window.open('/frame')">新标签</button><a href="/frame">导航</a><p hidden>隐藏线索</p><div id="shadow"></div><iframe src="/frame"></iframe><p>${'长段落'.repeat(10000)}</p><p>末尾的证据</p></main><script>document.cookie='shared=yes';document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>影子按钮</button>'</script>`,
      )
    })
    await listenForTest(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('端口错误')
    const ctx = new Context()
    contexts.push(ctx)
    class ImageSink extends Service {
      constructor(ctx: Context) {
        super(ctx, 'ai')
      }
      async storeToolImage(_context: RunContext, data: GeneratedImage) {
        return { ...image, width: data.width, height: data.height, size: data.data.byteLength }
      }
    }
    new ImageSink(ctx)
    await ctx.plugin(http)
    await ctx.plugin(playwright, { context: { viewport: { width: 800, height: 600 } } })
    const browser = new BrowserTools(ctx, { timeoutMs: 10000 })
    const run = context()
    const execute = (name: string, args: import('@antarestra/ai').JsonObject, who = run) =>
      browser.execute(name, args, who)
    try {
      const opened = await execute('web_open', { url: `http://127.0.0.1:${address.port}` })
      expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true)
      const page = opened.content as Record<string, import('@antarestra/ai').Json>
      const pageId = String(page.pageId)
      expect(page.truncated).toBe(true)
      expect(
        JSON.stringify(await execute('web_snapshot', { pageId, cursor: page.nextCursor! })),
      ).toContain('末尾的证据')
      const text = String(page.content)
      const ref = (label: string) =>
        text
          .split('\n')
          .find((line) => line.includes(label))!
          .match(/\[ref=([^\]]+)\]/)![1]!
      const result = await execute(
        'web_interact',
        {
          pageId,
          actions: [
            { type: 'fill', ref: ref('textbox'), text: '新的搜索结果' },
            { type: 'click', ref: ref('执行搜索') },
          ],
        },
        context('other-actor'),
      )
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result)).toContain('新的搜索结果')
      expect(browser.sessions.entries.size).toBe(1)
      expect(JSON.stringify(await execute('web_find', { pageId, text: '末尾的证据' }))).toContain(
        '"total":1',
      )
      expect(JSON.stringify(await execute('web_find', { pageId, text: '导航里的线索' }))).toContain(
        '"total":1',
      )
      expect(JSON.stringify(await execute('web_find', { pageId, text: '隐藏线索' }))).toContain(
        '"total":0',
      )
      expect(
        JSON.stringify(
          await execute('web_find', { pageId, text: '隐藏线索', includeHidden: true }),
        ),
      ).toContain('"hidden":true')
      expect(JSON.stringify(await execute('web_find', { pageId, text: '框架里的证据' }))).toContain(
        '"total":1',
      )
      expect(
        JSON.stringify(await execute('web_snapshot', { pageId }, context('actor', 'other-space'))),
      ).toContain('page_expired')
      const shot = await execute('web_screenshot', { pageId })
      expect(shot.images?.[0]).toMatchObject({ width: 800, height: 600 })
      const dialog = await execute('web_interact', {
        pageId,
        actions: [
          { type: 'click', ref: ref('显示对话框') },
          { type: 'fill', ref: ref('textbox'), text: '不得执行' },
        ],
      })
      expect(JSON.stringify(dialog)).toContain('not_executed')
      expect(JSON.stringify(dialog)).toContain('等待确认')
      expect(
        (await execute('web_interact', { pageId, actions: [{ type: 'dialog', accept: true }] }))
          .isError,
      ).toBe(false)
      const controller = new AbortController()
      const first = execute('web_interact', {
        pageId,
        actions: [{ type: 'wait', text: '不存在', timeoutMs: 500 }],
      })
      const second = execute(
        'web_open',
        { action: 'close', pageId },
        context('actor', 'space', controller.signal),
      )
      controller.abort()
      await expect(second).rejects.toBeDefined()
      await first
      expect((await execute('web_snapshot', { pageId })).isError).not.toBe(true)
      const popup = await execute('web_interact', {
        pageId,
        actions: [
          { type: 'click', ref: ref('新标签') },
          { type: 'fill', ref: ref('textbox'), text: '不得执行' },
        ],
      })
      expect(JSON.stringify(popup)).toContain('not_executed')
      const pages = (popup.content as { pages: { pageId: string }[] }).pages
      expect(pages.length).toBe(2)
      const navigation = await execute('web_interact', {
        pageId,
        actions: [
          { type: 'click', ref: ref('link') },
          { type: 'fill', ref: ref('textbox'), text: '不得执行' },
        ],
      })
      expect(JSON.stringify(navigation)).toContain('框架里的证据')
      expect(JSON.stringify(navigation)).toContain('not_executed')
      const stale = await execute('web_interact', {
        pageId,
        actions: [{ type: 'click', ref: ref('执行搜索') }],
      })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale)).toContain('stale_element')
      expect(JSON.stringify(stale)).toContain('框架里的证据')
      pdfBytes = await ctx.playwright.withPage(ctx, async (page) => {
        await page.setContent(
          '<h1>PDF evidence</h1><p style="break-before:page">Second page evidence</p>',
        )
        return page.pdf()
      })
      const parsed = await PdfDocument.open(pdfBytes)
      expect(parsed.texts.length).toBe(2)
      await parsed.close()
      const pdf = await execute('web_open', { url: `http://127.0.0.1:${address.port}/doc.pdf` })
      expect(pdf.isError).not.toBe(true)
      expect(JSON.stringify(pdf)).toContain('PDF evidence')
      const pdfId = String((pdf.content as Record<string, unknown>).pageId)
      expect(
        JSON.stringify(await execute('web_find', { pageId: pdfId, text: 'Second page' })),
      ).toContain('"pdfPage":2')
      expect((await execute('web_screenshot', { pageId: pdfId, pdfPage: 2 })).images?.length).toBe(
        1,
      )
      const activeController = new AbortController()
      const active = execute(
        'web_interact',
        {
          pageId,
          actions: [{ type: 'wait', text: '永远不会出现', timeoutMs: 5000 }],
        },
        context('actor', 'space', activeController.signal),
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      activeController.abort()
      await expect(active).rejects.toBeDefined()
      expect(JSON.stringify(await execute('web_snapshot', { pageId }))).toContain('page_expired')
      await ctx.fiber.dispose()
      expect(browser.sessions.entries.size).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  45000,
)
