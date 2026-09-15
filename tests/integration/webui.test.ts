import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import Server from '@antarestra/plugin-server'
import WebUI from '@antarestra/webui'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-webui-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'index.js'), 'export default ctx => {}')
  await writeFile(join(directory, 'index.html'), '<div id="app"></div>')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const server = await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  const webui = await ctx.plugin(WebUI, { directory })
  const url = `http://127.0.0.1:${ctx.server.address!.port}`
  return { ctx, webui, server, directory, get: (path: string) => fetch(url + path) }
}

describe('WebUI 插件', () => {
  it('根路径和页面直达返回构建页面，API 和丢失资源不回退为 HTML', async () => {
    const app = await setup()
    for (const path of ['/', '/auth/user/', '/auth/user']) {
      const response = await app.get(path)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="app"></div>')
    }
    for (const path of [
      '/api/missing',
      '/webui/missing.js',
      '/missing.js',
      '/webui/extensions/a/%2e%2e/private',
    ])
      expect((await app.get(path)).status).toBe(404)
    expect((await app.get('/api/health')).status).toBe(200)
    expect((await app.get('/webui/entries.json')).headers.get('X-WebUI-HMR')).toBeNull()
  })
  it('入口重复拒绝，独立卸载回收清单与资源，旧回收不删除新入口', async () => {
    const app = await setup()
    let dispose!: () => Promise<void>
    const first = await app.ctx.plugin({
      inject: ['webui'],
      apply(ctx: Context) {
        dispose = ctx.webui.addEntry(ctx, {
          id: 'first',
          directory: app.directory,
          config: { label: '测试' },
        })
      },
    })
    const second = await app.ctx.plugin({
      inject: ['webui'],
      apply(ctx: Context) {
        ctx.webui.addEntry(ctx, { id: 'second', directory: app.directory })
      },
    })
    expect(() =>
      app.ctx.webui.addEntry(app.ctx, { id: 'first', directory: app.directory }),
    ).toThrow('重复')
    const entries = (await (await app.get('/webui/entries.json')).json()) as {
      id: string
      url: string
    }[]
    expect(entries.map((entry) => entry.id)).toEqual(['first', 'second'])
    expect((await app.get(entries[0]!.url)).status).toBe(200)
    await first.dispose()
    expect((await app.get(entries[0]!.url)).status).toBe(404)
    app.ctx.webui.addEntry(app.ctx, { id: 'first', directory: app.directory })
    await dispose()
    expect(await (await app.get('/webui/entries.json')).json()).toHaveLength(2)
    await second.dispose()
    expect(await (await app.get('/webui/entries.json')).json()).toHaveLength(1)
    const remaining = (await (await app.get('/webui/entries.json')).json()) as { url: string }[]
    await app.webui.dispose()
    expect((await app.get(remaining[0]!.url)).status).toBe(404)
    expect((await app.get('/')).status).toBe(404)
    expect((await app.get('/webui/entries.json')).status).toBe(404)
    expect((await app.get('/api/health')).status).toBe(200)
  })
  it('server 依赖卸载回收 WebUI，重新提供服务后重新注册扩展', async () => {
    const app = await setup()
    await app.ctx.plugin({
      inject: ['webui'],
      apply(ctx: Context) {
        ctx.webui.addEntry(ctx, { id: 'dependent', directory: app.directory })
      },
    })
    await app.server.dispose()
    await app.ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
    await app.webui
    await new Promise((resolve) => setTimeout(resolve, 30))
    const response = await fetch(
      `http://127.0.0.1:${app.ctx.server.address!.port}/webui/entries.json`,
    )
    expect(await response.json()).toHaveLength(1)
  })
})
