import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import Server from '@antarestra/plugin-server'
import WebUI from '@antarestra/webui'
import type { EntryManifest } from '@antarestra/webui'
import { WebSocket } from 'ws'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWebHmr } from '../../plugins/features/hmr/src/webui.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(excludeAssets = false) {
  const directory = await mkdtemp(join(tmpdir(), '前端 HMR '))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'index.js'), "export { default } from './component.js'")
  await writeFile(join(directory, 'component.js'), 'export default () => "初始"')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  const webui = await ctx.plugin(WebUI, { directory })
  const origin = `http://127.0.0.1:${ctx.server.address!.port}`
  const bridge = await ctx.plugin({
    apply(owner: Context) {
      owner.inject(['webui', 'server'], (scope) =>
        applyWebHmr(scope, [directory], excludeAssets ? [directory] : []),
      )
    },
  })
  await expect
    .poll(async () => (await fetch(`${origin}/webui/entries.json`)).headers.get('X-WebUI-HMR'))
    .toBe('/webui/hmr')
  const messages: EntryManifest[][] = []
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/webui/hmr`, { origin })
  socket.on('message', (data) =>
    messages.push((JSON.parse(data.toString()) as { entries: EntryManifest[] }).entries),
  )
  cleanups.push(async () => {
    socket.terminate()
  })
  await expect.poll(() => messages.length).toBe(1)
  return { ctx, directory, origin, bridge, socket, messages, webui }
}

describe('前端 HMR 通道', () => {
  it('推送加载、资源变化和卸载；重连获得快照；停用后回收连接与监视器', async () => {
    const app = await setup()
    expect(app.messages[0]).toEqual([])
    const entry = await app.ctx.plugin({
      inject: ['webui'],
      apply(ctx: Context) {
        ctx.webui.addEntry(ctx, { id: 'demo', directory: app.directory })
      },
    })
    await expect.poll(() => app.messages.at(-1)?.length).toBe(1)
    const before = app.messages.at(-1)![0]!.url
    // 等待新目录的初始扫描，随后用真实文件事件驱动更新。
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(join(app.directory, 'component.js'), 'export default () => "更新"')
    await expect.poll(() => app.messages.at(-1)?.[0]?.url).not.toBe(before)
    const current = app.messages.at(-1)![0]!.url
    expect(await (await fetch(app.origin + current)).text()).toContain('./component.js')
    expect(await (await fetch(new URL('./component.js', app.origin + current))).text()).toContain(
      '更新',
    )
    expect((await fetch(app.origin + before)).status).toBe(404)
    const reconnect = new WebSocket(`${app.origin.replace('http', 'ws')}/webui/hmr`, {
      origin: app.origin,
    })
    const snapshot = await new Promise<{ entries: EntryManifest[] }>((resolve) =>
      reconnect.once('message', (data) =>
        resolve(JSON.parse(data.toString()) as { entries: EntryManifest[] }),
      ),
    )
    reconnect.terminate()
    expect(snapshot.entries[0]!.url).toBe(current)
    await entry.dispose()
    await expect.poll(() => app.messages.at(-1)).toEqual([])
    const closed = new Promise<number>((resolve) => app.socket.once('close', resolve))
    await app.bridge.dispose()
    expect(await closed).toBe(1000)
    expect((await fetch(`${app.origin}/webui/entries.json`)).headers.get('X-WebUI-HMR')).toBeNull()
    const count = app.messages.length
    await writeFile(join(app.directory, 'index.js'), '停用后更新')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(app.messages).toHaveLength(count)
  })

  it('排除目录不触发资源刷新，但仍通知扩展注册与卸载', async () => {
    const app = await setup(true)
    const plugin = await app.ctx.plugin({
      inject: ['webui'],
      apply(ctx: Context) {
        ctx.webui.addEntry(ctx, { id: 'excluded', directory: app.directory })
      },
    })
    await expect.poll(() => app.messages.at(-1)?.length).toBe(1)
    const before = app.messages.length
    await writeFile(join(app.directory, 'component.js'), '排除目录不更新')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(app.messages).toHaveLength(before)
    await plugin.dispose()
    await expect.poll(() => app.messages.at(-1)).toEqual([])
  })

  it('拒绝跨站连接，WebUI 依赖重建后恢复桥接', async () => {
    const app = await setup()
    const foreign = new WebSocket(`${app.origin.replace('http', 'ws')}/webui/hmr`, {
      origin: 'https://example.com',
    })
    await new Promise<void>((resolve) => foreign.once('error', () => resolve()))
    expect(foreign.readyState).not.toBe(WebSocket.OPEN)
    const closed = new Promise((resolve) => app.socket.once('close', resolve))
    await app.webui.dispose()
    await closed
    await app.ctx.plugin(WebUI, { directory: app.directory })
    await expect
      .poll(async () =>
        (await fetch(`${app.origin}/webui/entries.json`)).headers.get('X-WebUI-HMR'),
      )
      .toBe('/webui/hmr')
  })
})
