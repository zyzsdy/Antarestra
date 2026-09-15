import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { defineWebUIConfig } from '@antarestra/webui/vite'
import { router } from '../../plugins/definitions/webui/client/runtime.js'
import type { ClientContext, ClientPlugin, Page } from '@antarestra/webui/client'

describe('WebUI SFC 构建', () => {
  it('模板与聊天产物复用页面壳 Vue，保留 scoped CSS 并随扩展卸载回收链接', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'antarestra-sfc-'))
    const fixture = await mkdtemp(resolve('plugins/features/.sfc-test-'))
    await cp(resolve('templates/webui-plugin'), fixture, { recursive: true })
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
        expect(code).not.toContain('function createRenderer(')
        expect(css).toMatch(/\[data-v-[a-f0-9]+\]/)
        const links: { rel: string; href: string; remove: () => void }[] = []
        vi.stubGlobal('document', {
          createElement: () => ({ rel: '', href: '', remove: vi.fn() }),
          head: { append: (link: (typeof links)[number]) => links.push(link) },
        })
        const effects: (() => void)[] = []
        const pages: Page[] = []
        const ctx: ClientContext = {
          vue: Reflect.get(globalThis, Symbol.for('antarestra.webui.vue')),
          router,
          config: {},
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
