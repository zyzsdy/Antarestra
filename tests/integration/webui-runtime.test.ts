/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pages, router, startExtensions } from '../../plugins/definitions/webui/client/runtime.js'
import type { EntryManifest } from '@antarestra/webui'
import type { ClientContext } from '@antarestra/webui/client'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

class Socket {
  static instances: Socket[] = []
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number }) => void
  close = vi.fn()
  constructor(readonly url: URL) {
    Socket.instances.push(this)
  }
  entries(entries: EntryManifest[]) {
    this.onmessage?.({ data: JSON.stringify({ type: 'entries', entries }) })
  }
}

function setup(hmr: boolean) {
  Socket.instances = []
  vi.stubGlobal('location', { origin: 'https://localhost' })
  vi.stubGlobal('WebSocket', Socket)
  const fetcher = vi.fn(
    async () =>
      new Response('[]', {
        headers: hmr ? { 'X-WebUI-HMR': '/webui/hmr' } : {},
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

function entry(id: string, version = 1): EntryManifest {
  return { id, url: `/webui/extensions/${id}/${version}/index.js`, config: { id, version } }
}

describe('浏览器扩展更新', () => {
  it('批量注册只重新匹配受影响的当前路径，无关路由变化不重复触发守卫', async () => {
    setup(true)
    await router.push('/target/')
    vi.stubGlobal('window', new EventTarget())
    const guard = vi.fn(() => true)
    const removeGuard = router.beforeEach(guard)
    try {
      stop = startExtensions(async () => ({
        default: (ctx: ClientContext) => {
          const id = String(ctx.config.id)
          for (const path of id === 'target' ? ['/target/', '/extra/'] : ['/unrelated/'])
            ctx.page({ path, name: path, component: {} })
        },
      }))
      await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
      Socket.instances[0]!.entries([entry('target')])
      await vi.waitFor(() => expect(router.currentRoute.value.matched[0]?.path).toBe('/target/'))
      expect(guard).toHaveBeenCalledTimes(1)
      Socket.instances[0]!.entries([entry('target'), entry('other')])
      await vi.waitFor(() => expect(pages.has('/unrelated/')).toBe(true))
      expect(guard).toHaveBeenCalledTimes(1)
      Socket.instances[0]!.entries([entry('target')])
      await vi.waitFor(() => expect(pages.has('/unrelated/')).toBe(false))
      expect(guard).toHaveBeenCalledTimes(1)
    } finally {
      removeGuard()
    }
  })

  it('首页由扩展注册，异步守卫在进入前执行，卸载后根路由回收', async () => {
    setup(true)
    let allowed = false
    const guard = vi.fn(() => allowed)
    stop = startExtensions(async () => ({
      default: (ctx: ClientContext) => {
        ctx.page({ path: '/', name: '聊天', component: {}, beforeEnter: guard })
      },
    }))
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
    Socket.instances[0]!.entries([entry('chat')])
    await vi.waitFor(() => expect(pages.has('/')).toBe(true))
    await router.push('/other/')
    await router.push('/')
    expect(guard).toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/other/')
    allowed = true
    await router.push('/')
    expect(router.currentRoute.value.path).toBe('/')
    stop()
    expect(pages.has('/')).toBe(false)
    expect(router.getRoutes().some((route) => route.path === '/')).toBe(false)
  })

  it('未启用 HMR 时只获取一次清单，不创建连接或轮询', async () => {
    vi.useFakeTimers()
    const fetcher = setup(false)
    stop = startExtensions()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(Socket.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('推送仅替换受影响的组件并清理副作用；重复快照不重复加载', async () => {
    const fetcher = setup(true)
    const disposed: string[] = []
    const loader = vi.fn(async () => ({
      default: (ctx: ClientContext) => {
        const id = String(ctx.config.id)
        ctx.page({ path: `/${id}/`, name: id, component: { template: String(ctx.config.version) } })
        ctx.effect(() => () => {
          disposed.push(id)
        })
      },
    }))
    stop = startExtensions(loader)
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
    const socket = Socket.instances[0]!
    expect(socket.url.protocol).toBe('wss:')
    socket.entries([entry('first'), entry('second')])
    await vi.waitFor(() => expect(pages.size).toBe(2))
    const unaffected = pages.get('/second/')
    const original = pages.get('/first/')
    socket.entries([entry('first', 2), entry('second')])
    socket.entries([entry('first', 2), entry('second')])
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(3))
    expect(pages.get('/first/')).not.toBe(original)
    expect(pages.get('/second/')).toBe(unaffected)
    expect(disposed).toEqual(['first'])
    socket.entries([entry('second')])
    await vi.waitFor(() => expect(pages.has('/first/')).toBe(false))
    expect(fetcher).toHaveBeenCalledTimes(1)
    stop()
    expect(pages.size).toBe(0)
    expect(socket.close).toHaveBeenCalled()
    expect(disposed).toEqual(['first', 'first', 'second'])
  })

  it('异常断线重连，正常停用与页面卸载后停止重连', async () => {
    vi.useFakeTimers()
    const fetcher = setup(true)
    stop = startExtensions()
    await vi.advanceTimersByTimeAsync(0)
    Socket.instances[0]!.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(Socket.instances).toHaveLength(2)
    fetcher.mockImplementation(async () => new Response('[]'))
    Socket.instances[1]!.onclose?.({ code: 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(Socket.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    Socket.instances[1]!.onclose?.({ code: 1006 })
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(Socket.instances).toHaveLength(2)
  })

  it('扩展仍在异步初始化时卸载页面，也立即回收已注册的页面与副作用', async () => {
    setup(true)
    let finish!: () => void
    const initializing = new Promise<void>((resolve) => {
      finish = resolve
    })
    const dispose = vi.fn()
    stop = startExtensions(async () => ({
      default: async (ctx: ClientContext) => {
        ctx.page({ path: '/pending/', name: '等待中', component: {} })
        ctx.effect(() => dispose)
        await initializing
      },
    }))
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
    Socket.instances[0]!.entries([entry('pending')])
    await vi.waitFor(() => expect(pages.has('/pending/')).toBe(true))
    stop()
    expect(pages.size).toBe(0)
    expect(dispose).toHaveBeenCalledTimes(1)
    finish()
    await initializing
    expect(pages.size).toBe(0)
  })
})

it('插槽允许先贡献后消费，拒绝重复注册，失败与卸载回收且旧回收不删除新实例', async () => {
  setup(true)
  const contexts = new Map<string, ClientContext>()
  const cleanup: (() => void)[] = []
  stop = startExtensions(async () => ({
    default: (ctx) => {
      const id = String(ctx.config.id)
      contexts.set(id, ctx)
      if (id === 'broken') {
        ctx.contribute('test.pages', 'broken', {})
        throw new Error('测试初始化失败')
      }
      if (id === 'author') cleanup.push(ctx.contribute('test.pages', 'page', { title: '页面' }))
    },
  }))
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  const socket = Socket.instances[0]!
  socket.entries([entry('author'), entry('host')])
  await vi.waitFor(() => expect(contexts.has('host')).toBe(true))
  const pages = contexts.get('host')!.slot<{ title: string }>('test.pages')
  expect(pages.get('page')).toEqual({ title: '页面' })
  expect(() => contexts.get('host')!.contribute('test.pages', 'page', {})).toThrow('重复')
  socket.entries([entry('host'), entry('broken')])
  await vi.waitFor(() => expect(contexts.has('broken')).toBe(true))
  expect(pages.size).toBe(0)
  socket.entries([entry('host'), entry('author', 2)])
  await vi.waitFor(() => expect(pages.size).toBe(1))
  cleanup[0]!()
  expect(pages.size).toBe(1)
  stop()
  expect(pages.size).toBe(0)
  expect(() => contexts.get('author')!.contribute('test.pages', 'late', {})).toThrow('已卸载')
})
