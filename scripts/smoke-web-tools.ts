import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { listenForTest } from './test-listen.js'
import { Context } from '@antarestra/plugin-sdk'
import * as http from '@antarestra/http'
import * as playwright from '@antarestra/playwright'
import { BrowserTools } from '@antarestra/plugin-web-tools'
import type { JsonObject, RunContext } from '@antarestra/ai'

// 必须通过 tsx 子进程执行，覆盖开发运行器将函数序列化到浏览器的真实路径。
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url === '/challenge') {
    res.writeHead(403, { 'cf-mitigated': 'challenge' })
    res.end(
      '<title>Just a moment...</title><p>Verify you are human</p><script>setTimeout(() => location.href="/verified", 1200)</script>',
    )
    return
  }
  if (req.url === '/verified') {
    res.end('<title>验证后正文</title><main>已通过测试验证</main>')
    return
  }
  res.end(
    req.url === '/frame'
      ? '<p>子框架证据</p><button onclick="this.textContent=\'子框架已点击\'">框架操作</button>'
      : `<!doctype html><title>网页工具验证</title><nav>导航线索</nav>
        <main><h1>测试正文</h1><p id="result">初始内容</p>
        <button onclick="document.querySelector('#result').textContent='交互完成'">执行操作</button>
        <label>密码<input type="password" value="不得泄露的密码"></label>
        <label>特殊密码<input type="password" role="searchbox" value="另一段秘密"></label>
        <label>启用<input type="checkbox"></label>
        <label>选择<select><option value="a">甲</option><option value="b">乙</option></select></label>
        <p hidden>隐藏正文验证</p>
        <div id="shadow"></div><iframe src="/frame"></iframe></main>
        <script>
          document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>影子正文</p>'
          setTimeout(() => document.querySelector('#result').textContent='延迟正文', 100)
        </script>`,
  )
})
const ctx = new Context()
let browser: BrowserTools | undefined
try {
  await listenForTest(server)
  const address = server.address()
  assert(address && typeof address !== 'string')
  await ctx.plugin(http)
  await ctx.plugin(playwright)
  browser = new BrowserTools(ctx, { timeoutMs: 10000 })
  const run: RunContext = {
    runId: 'smoke',
    conversationId: 'conversation',
    workspaceId: 'space',
    actorId: 'actor',
    signal: new AbortController().signal,
    agent: {
      id: 'agent',
      version: '1',
      title: '网页验证',
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
  const execute = async (name: string, args: JsonObject) => {
    const result = await browser!.execute(name, args, run)
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return result.content as JsonObject
  }
  const opened = await execute('web_open', {
    url: `http://127.0.0.1:${address.port}`,
    view: 'main',
  })
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.warnings, [])
  const content = String(opened.content)
  assert.match(content, /测试正文/)
  assert.match(content, /延迟正文/)
  assert.match(content, /影子正文/)
  assert.doesNotMatch(content, /导航线索/)
  assert.doesNotMatch(content, /不得泄露的密码/)
  assert.doesNotMatch(content, /另一段秘密/)
  const pageId = String(opened.pageId)
  for (const text of ['导航线索', '子框架证据']) {
    const found = await execute('web_find', { pageId, text })
    assert.equal(found.total, 1)
    assert.deepEqual(found.warnings, [])
  }
  const ref = content
    .split('\n')
    .find((line) => line.includes('执行操作'))
    ?.match(/\[ref=([^\]]+)\]/)?.[1]
  assert(ref)
  const clicked = await execute('web_interact', { pageId, actions: [{ type: 'click', ref }] })
  assert.match(JSON.stringify(clicked), /交互完成/)
  const fresh = await execute('web_snapshot', { pageId })
  const nativeRef = (label: string) => {
    const value = String(fresh.content)
      .split('\n')
      .find((line) => line.includes(label))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    assert(value, label)
    return value
  }
  assert.match(nativeRef('框架操作'), /:pw:f\d+e\d+$/)
  const updated = await execute('web_interact', {
    pageId,
    actions: [
      { type: 'check', ref: nativeRef('checkbox'), checked: true },
      { type: 'select', ref: nativeRef('combobox'), value: 'b' },
      { type: 'click', ref: nativeRef('框架操作') },
    ],
  })
  assert.match(JSON.stringify(updated), /子框架已点击/)
  assert.match(JSON.stringify(updated), /checked/)
  const subtree = await execute('web_snapshot', { pageId, ref: nativeRef('checkbox') })
  assert.match(String(subtree.content), /checkbox/)
  assert.doesNotMatch(String(subtree.content), /框架操作/)
  const full = await execute('web_snapshot', { pageId, view: 'full' })
  assert.doesNotMatch(String(full.content), /不得泄露的密码/)
  const fullMain = await execute('web_snapshot', { pageId, ref: nativeRef('main'), view: 'full' })
  assert.match(String(fullMain.content), /隐藏正文验证/)
  const foundButton = await execute('web_find', { pageId, text: '执行操作' })
  const indexedRef = (foundButton.matches as JsonObject[])[0]!.ref
  await execute('web_interact', { pageId, actions: [{ type: 'click', ref: indexedRef! }] })
  const challenge = await execute('web_open', {
    pageId,
    url: `http://127.0.0.1:${address.port}/challenge`,
  })
  assert.equal(challenge.status, 403)
  assert.match(JSON.stringify(challenge.notices), /verification_required/)
  const verified = await execute('web_interact', {
    pageId,
    actions: [{ type: 'wait', url: '/verified' }],
  })
  const verifiedPage = verified.page as JsonObject
  assert.equal(verifiedPage.status, 200)
  assert.deepEqual(verifiedPage.notices, [])
  const stale = await browser.execute(
    'web_interact',
    { pageId, actions: [{ type: 'click', ref }] },
    run,
  )
  assert.equal(stale.isError, true)
  assert.match(JSON.stringify(stale), /stale_element/)
  console.log('网页工具验证通过：正文、延迟渲染、子框架、Shadow DOM、全文查找与元素交互。')
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
