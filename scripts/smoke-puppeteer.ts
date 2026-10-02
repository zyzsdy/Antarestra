import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@antarestra/plugin-sdk'
import * as puppeteer from '@antarestra/puppeteer'

// 使用系统浏览器验证真实渲染；不访问外网、不下载浏览器。
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>浏览器验证</title><body><h1>真实页面</h1></body>')
})
const ctx = new Context()
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/`
  const fiber = await ctx.plugin(
    puppeteer,
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  )
  const content = await ctx.puppeteer.read(ctx, url)
  assert.equal(content.title, '浏览器验证')
  assert.equal(content.text, '真实页面')
  assert.equal(content.status, 200)
  const png = await ctx.puppeteer.screenshot(
    ctx,
    '<!doctype html><html><body style="margin:0;background:#375a7f;color:white"><h1>HTML 截图</h1></body></html>',
    { viewport: { width: 480, height: 240 } },
  )
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 480)
  assert.equal(png.readUInt32BE(20), 240)
  const first = await ctx.puppeteer.createPage(ctx)
  const second = await ctx.puppeteer.createPage(ctx)
  const browser = first.page.browser()
  await first.page.goto(url)
  await first.page.evaluate(() => {
    document.cookie = 'isolation=first'
  })
  await second.page.goto(url)
  assert.equal(await second.page.evaluate(() => document.cookie), '')
  await first.close()
  await second.close()
  await assert.rejects(
    ctx.puppeteer.withPage(ctx, async () => {
      throw new Error('预期失败')
    }),
    /预期失败/,
  )
  assert.equal(browser.browserContexts().length, 1)
  await fiber.dispose()
  assert.equal(browser.connected, false)
  assert.notEqual(browser.process()?.exitCode, null)
  console.log(
    '真实 Chrome 验证通过：页面读取、480×240 PNG 截图、Cookie 隔离、异常回收及浏览器进程退出。',
  )
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
