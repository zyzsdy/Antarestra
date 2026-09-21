import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { defineWebUIConfig } from '@antarestra/webui/vite'
import { router, session } from '../../plugins/definitions/webui/client/runtime.js'
import type { ClientContext, ClientPlugin, Page } from '@antarestra/webui/client'

describe('WebUI SFC 构建', () => {
  it('模板与聊天产物复用页面壳 Vue，保留 scoped CSS 并随扩展卸载回收链接', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-sfc-'))
    const fixture = await mkdtemp(resolve('plugins/features/.sfc-test-'))
    await cp(resolve('templates/webui-plugin'), fixture, { recursive: true })
    const fixtureEntry = join(fixture, 'client/index.ts')
    await writeFile(
      fixtureEntry,
      "import * as components from '@antarestra/webui/components'\n" +
        (await readFile(fixtureEntry, 'utf8')).replace(
          '  ctx.page(',
          "  ctx.contribute('test', 'components', components)\n  ctx.page(",
        ),
    )
    try {
      for (const source of [fixture, 'plugins/features/chat-webui']) {
        const outDir = join(directory, source === fixture ? 'template' : 'chat')
        const config = defineWebUIConfig()
        await build({
          ...config,
          configFile: false,
          root: resolve(source),
          logLevel: 'silent',
          build: { ...config.build, outDir },
        })
        const code = await readFile(join(outDir, 'index.js'), 'utf8')
        const css = await readFile(join(outDir, 'style.css'), 'utf8')
        expect(code).toContain('antarestra.webui.vue')
        expect(code).toContain('antarestra.webui.reka')
        expect(code).not.toContain('function createRenderer(')
        expect(css).toMatch(/\[data-v-[a-f0-9]+\]/)
        const links: { rel: string; href: string; remove: () => void }[] = []
        vi.stubGlobal('document', {
          createElement: () => ({ rel: '', href: '', remove: vi.fn() }),
          head: { append: (link: (typeof links)[number]) => links.push(link) },
        })
        const effects: (() => void)[] = []
        const pages: Page[] = []
        let components: Record<string, unknown> | undefined
        const ctx: ClientContext = {
          vue: Reflect.get(globalThis, Symbol.for('antarestra.webui.vue')),
          router,
          session,
          config: {},
          slot: () => new Map(),
          contribute: (_slot, _id, value) => {
            components = value as Record<string, unknown>
            return () => {}
          },
          page: (page) => {
            pages.push(page)
            return () => {}
          },
          effect: (setup) => {
            const cleanup = setup()
            if (cleanup) effects.push(cleanup)
          },
        }
        const module = (await import(
          /* @vite-ignore */ pathToFileURL(join(outDir, 'index.js')).href
        )) as { default: ClientPlugin }
        await module.default(ctx)
        if (source === fixture) {
          const reka = Reflect.get(globalThis, Symbol.for('antarestra.webui.reka')) as Record<
            string,
            unknown
          >
          for (const [name, value] of Object.entries(reka)) expect(components?.[name]).toBe(value)
          expect(components?.EditorDialog).toBeDefined()
          expect(components?.CheckboxField).toBeDefined()
        }
        expect(pages).toHaveLength(1)
        expect(links).toHaveLength(1)
        expect(links[0]!.href).toBe(pathToFileURL(join(outDir, 'style.css')).href)
        for (const dispose of effects.reverse()) dispose()
        expect(links[0]!.remove).toHaveBeenCalledTimes(1)
        vi.unstubAllGlobals()
      }
    } finally {
      vi.unstubAllGlobals()
      await rm(directory, { recursive: true, force: true })
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

it('后台构建产物支持先贡献后挂载、独立卸载与重载，并对深层路由和大小写路径鉴权', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antarestra-admin-sfc-'))
  const { pages, startExtensions } =
    await import('../../plugins/definitions/webui/client/runtime.js')
  let stop: (() => void) | undefined
  let socket: { onmessage?: (event: { data: string }) => void } | undefined
  const requests: string[] = []
  const links: { remove: () => void }[] = []
  try {
    const config = defineWebUIConfig()
    await build({
      ...config,
      configFile: false,
      root: resolve('plugins/features/admin-console'),
      logLevel: 'silent',
      build: { ...config.build, outDir: directory },
    })
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(join(directory, 'index.js')).href
    )) as { default: ClientPlugin }
    vi.stubGlobal('document', {
      createElement: () => ({ remove: vi.fn() }),
      head: { append: (link: { remove: () => void }) => links.push(link) },
    })
    vi.stubGlobal('location', { origin: 'https://localhost' })
    vi.stubGlobal(
      'WebSocket',
      class {
        onmessage?: (event: { data: string }) => void
        constructor() {
          socket = this
        }
        close() {}
      },
    )
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === '/webui/entries.json')
        return new Response('[]', { headers: { 'X-WebUI-HMR': '/webui/hmr' } })
      requests.push(url)
      throw new Error('路由守卫不得请求鉴权 API')
    })
    session.set({
      actorId: 'test',
      displayName: '测试管理员',
      accountPath: '/auth/user/',
      expiresAt: Date.now() + 60_000,
      permissions: ['admin.console.view', 'example.page.view'],
    })
    stop = startExtensions(async (url) =>
      url.includes('/admin/')
        ? module
        : {
            default: (ctx) => {
              ctx.contribute('admin-console.pages', 'example', {
                id: 'example',
                group: '测试插件',
                title: '测试页面',
                icon: {},
                permission: 'example.page.view',
                component: {},
              })
            },
          },
    )
    await vi.waitFor(() => expect(socket).toBeDefined())
    const entry = (id: string) => ({ id, url: `/webui/extensions/${id}/index.js`, config: {} })
    const sync = (ids: string[]) =>
      socket!.onmessage!({ data: JSON.stringify({ type: 'entries', entries: ids.map(entry) }) })
    sync(['author', 'admin'])
    await vi.waitFor(() => expect(pages.has('/admin/example/')).toBe(true))
    await router.push('/admin/example/')
    expect(requests).toHaveLength(0)
    const sessionRequests = requests.length
    await router.push('/admin/')
    await router.push('/admin/example/')
    expect(requests).toHaveLength(sessionRequests)
    expect(pages.get('/admin/')!.component).toBe(pages.get('/admin/example/')!.component)
    session.set({ ...session.read()!, permissions: ['admin.console.view'] })
    await router.push('/admin/')
    await router.push('/admin/example/')
    expect(router.currentRoute.value.path).toBe('/admin/access-denied/')
    session.clear()
    await router.push('/other/')
    await router.push('/ADMIN/EXAMPLE/')
    expect(requests).toHaveLength(0)
    expect(router.currentRoute.value.path).toBe('/auth/user/')
    expect(router.currentRoute.value.query.returnTo).toBe('/ADMIN/EXAMPLE/')
    sync(['author'])
    await vi.waitFor(() => expect(pages.has('/admin/')).toBe(false))
    expect(pages.has('/admin/example/')).toBe(false)
    const before = requests.length
    await router.push('/admin/example/')
    expect(requests).toHaveLength(before)
    sync(['author', 'admin'])
    await vi.waitFor(() => expect(pages.has('/admin/example/')).toBe(true))
    sync(['admin'])
    await vi.waitFor(() => expect(pages.has('/admin/example/')).toBe(false))
    expect(pages.has('/admin/')).toBe(true)
    stop()
    expect(pages.size).toBe(0)
    for (const link of links) expect(link.remove).toHaveBeenCalledTimes(1)
  } finally {
    stop?.()
    session.clear()
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  }
})
