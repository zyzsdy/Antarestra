import * as vue from 'vue'
import { createRouter, createWebHistory, createMemoryHistory } from 'vue-router'
import type { ClientContext, ClientPlugin, EntryManifest, Page } from '../src/client.js'

// 扩展的编译产物通过统一构建插件读取此共享运行时。
Object.defineProperty(globalThis, Symbol.for('antarestra.webui.vue'), {
  value: vue,
  configurable: true,
})

export const pages = vue.shallowReactive(new Map<string, Page>())
export const router = createRouter({
  history: typeof window === 'undefined' ? createMemoryHistory() : createWebHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
})
export const failures = vue.ref<string[]>([])
const loaded = new Map<string, { signature: string; dispose: () => void }>()

function context(config: EntryManifest['config']) {
  const effects: (() => void)[] = []
  let active = true
  const ctx: ClientContext = {
    vue,
    router,
    config,
    page(page) {
      if (!active) throw new Error('客户端扩展已卸载')
      if (
        !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(page.path) ||
        page.path.startsWith('/api/') ||
        page.path.startsWith('/webui/')
      )
        throw new Error('页面路径必须为带结尾斜杠的普通路径')
      if (pages.has(page.path)) throw new Error(`页面路径重复：${page.path}`)
      pages.set(page.path, page)
      const removeRoute = router.addRoute({
        path: page.path,
        component: page.component,
        ...(page.beforeEnter ? { beforeEnter: page.beforeEnter } : {}),
      })
      if (typeof window !== 'undefined') void router.replace(router.currentRoute.value.fullPath)
      let registered = true
      const dispose = () => {
        if (!registered) return
        registered = false
        removeRoute()
        if (pages.get(page.path) === page) pages.delete(page.path)
        if (typeof window !== 'undefined') void router.replace(router.currentRoute.value.fullPath)
      }
      effects.push(dispose)
      return dispose
    },
    effect(setup) {
      if (!active) throw new Error('客户端扩展已卸载')
      const dispose = setup()
      if (dispose) effects.push(dispose)
    },
  }
  return {
    ctx,
    dispose() {
      active = false
      for (const dispose of effects.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          console.error(error)
        }
      }
    },
  }
}

export function startExtensions(
  loadPlugin: (url: string) => Promise<{ default: ClientPlugin }> = (url) =>
    import(/* @vite-ignore */ url),
) {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let socket: WebSocket | undefined
  let queue = Promise.resolve()
  const pendingScopes = new Set<ReturnType<typeof context>>()
  async function sync(entries: EntryManifest[]) {
    const errors: string[] = []
    try {
      if (!active) return
      const signatures = new Map(entries.map((entry) => [entry.id, JSON.stringify(entry)]))
      for (const [id, entry] of loaded) {
        if (signatures.get(id) !== entry.signature) {
          entry.dispose()
          loaded.delete(id)
        }
      }
      for (const entry of entries) {
        if (loaded.has(entry.id)) continue
        const scope = context(entry.config)
        pendingScopes.add(scope)
        try {
          const url = new URL(entry.url, location.origin)
          if (url.origin !== location.origin || !url.pathname.startsWith('/webui/extensions/'))
            throw new Error('扩展入口地址无效')
          const module = await loadPlugin(url.href)
          if (!active) {
            scope.dispose()
            return
          }
          await module.default(scope.ctx)
          if (!active) {
            scope.dispose()
            return
          }
          loaded.set(entry.id, { signature: signatures.get(entry.id)!, dispose: scope.dispose })
        } catch (error) {
          scope.dispose()
          errors.push(`扩展 ${entry.id} 加载失败`)
          console.error(error)
        } finally {
          pendingScopes.delete(scope)
        }
      }
    } catch (error) {
      if (active) errors.push('页面扩展暂时不可用，请刷新页面重试。')
    } finally {
      if (active) {
        failures.value = errors
      }
    }
  }
  function schedule(entries: EntryManifest[]) {
    queue = queue.then(() => (active ? sync(entries) : undefined))
  }
  function connect(path: string) {
    if (!active) return
    const url = new URL(path, location.origin)
    if (url.origin !== location.origin || url.pathname !== '/webui/hmr') return
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url)
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type?: string
          entries?: EntryManifest[]
        }
        if (message.type === 'entries' && Array.isArray(message.entries)) schedule(message.entries)
      } catch (error) {
        console.error('HMR 消息无效', error)
      }
    }
    socket.onclose = () => {
      if (active) timer = setTimeout(() => void initialize(true), 1000)
    }
  }
  async function initialize(reconnecting = false) {
    try {
      const response = await fetch('/webui/entries.json', {
        signal: controller.signal,
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('无法获取页面扩展')
      const entries = (await response.json()) as EntryManifest[]
      if (!active) return
      schedule(entries)
      const hmr = response.headers.get('X-WebUI-HMR')
      if (hmr) connect(hmr)
    } catch (error) {
      if (active) {
        failures.value = ['页面扩展暂时不可用，请刷新页面重试。']
        if (reconnecting) timer = setTimeout(() => void initialize(true), 1000)
      }
    }
  }
  void initialize()
  return () => {
    active = false
    controller.abort()
    clearTimeout(timer)
    socket?.close()
    for (const scope of pendingScopes) scope.dispose()
    pendingScopes.clear()
    for (const entry of loaded.values()) entry.dispose()
    loaded.clear()
  }
}
