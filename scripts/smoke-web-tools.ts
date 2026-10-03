import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@antarestra/plugin-sdk'
import * as http from '@antarestra/http'
import * as puppeteer from '@antarestra/puppeteer'
import { BrowserTools } from '@antarestra/plugin-web-tools'
import type { JsonObject, RunContext } from '@antarestra/ai'

// 必须通过 tsx 子进程执行，覆盖开发运行器将函数序列化到浏览器的真实路径。
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(
    req.url === '/frame'
      ? '<p>子框架证据</p>'
      : `<!doctype html><title>网页工具验证</title><nav>导航线索</nav>
        <main><h1>测试正文</h1><p id="result">初始内容</p>
        <button onclick="document.querySelector('#result').textContent='交互完成'">执行操作</button>
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  await ctx.plugin(http)
  await ctx.plugin(puppeteer)
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
  const pageId = String(opened.pageId)
  for (const text of ['导航线索', '子框架证据']) {
    const found = await execute('web_find', { pageId, text })
    assert.equal(found.total, 1)
    assert.deepEqual(found.warnings, [])
  }
  const ref = content
    .split('\n')
    .find((line) => line.includes('执行操作'))
    ?.match(/\[([^\]]+)\]/)?.[1]
  assert(ref)
  const clicked = await execute('web_interact', { pageId, actions: [{ type: 'click', ref }] })
  assert.match(JSON.stringify(clicked), /交互完成/)
  console.log('网页工具验证通过：正文、延迟渲染、子框架、Shadow DOM、全文查找与元素交互。')
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
