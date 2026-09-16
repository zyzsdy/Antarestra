import { computed, defineComponent, h, reactive, watch } from 'vue'
import type { ClientPlugin } from '@antarestra/webui/client'
import { adminPagesSlot, registerAdminPage } from '../src/client.js'
import type { AdminPage } from '../src/client.js'
import ConsoleLayout from './ConsoleLayout.vue'
import OverviewPage from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  const entries = ctx.slot<AdminPage>(adminPagesSlot)
  const items = computed(() =>
    [...entries.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
    ),
  )
  const state = reactive({
    displayName: '',
    accountPath: '/auth/user/',
    failure: '',
    ready: false,
    collapsed: typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches,
  })
  const controller = new AbortController()
  const removers = new Map<string, { page: AdminPage; dispose: () => void }>()
  let revision = 0
  let stopWatch: (() => void) | undefined
  const stopGuard = ctx.router.beforeEach(async (to) => {
    const path = to.path.toLowerCase()
    if (path !== '/admin' && !path.startsWith('/admin/')) return
    const current = ++revision
    state.ready = false
    state.failure = ''
    const page = items.value.find((item) => path.replace(/\/$/, '') === `/admin/${item.id}`)
    try {
      const response = await fetch(
        '/api/admin-console/session' +
          (page?.permission ? `?permission=${encodeURIComponent(page.permission)}` : ''),
        { cache: 'no-store', signal: controller.signal },
      )
      const data = await response.json()
      if (controller.signal.aborted || current !== revision) return false
      if (
        response.status === 401 &&
        typeof data.loginPath === 'string' &&
        /^\/auth\/user\/(?:[a-z0-9-]+\/)?$/.test(data.loginPath)
      )
        return { path: data.loginPath, query: { returnTo: to.fullPath } }
      if (!response.ok) {
        state.failure =
          response.status === 401
            ? '请先登录后再访问管理控制台。'
            : data.error || '暂时无法验证访问权限'
        return
      }
      state.displayName = data.displayName
      if (
        typeof data.accountPath === 'string' &&
        /^\/auth\/user\/(?:[a-z0-9-]+\/)?$/.test(data.accountPath)
      )
        state.accountPath = data.accountPath
      state.ready = true
    } catch {
      if (controller.signal.aborted || current !== revision) return false
      state.failure = '无法验证访问权限，请稍后重试。'
    }
  })
  ctx.effect(() => () => {
    controller.abort()
    stopWatch?.()
    stopGuard()
    for (const record of removers.values()) record.dispose()
    removers.clear()
  })
  const component = (page: AdminPage) =>
    defineComponent(
      () => () =>
        h(ConsoleLayout, {
          ...state,
          page,
          items: items.value,
          router: ctx.router,
          onToggle: () => {
            state.collapsed = !state.collapsed
          },
        }),
    )
  registerAdminPage(ctx, {
    id: 'overview',
    title: '控制台概览',
    group: '工作台',
    icon: '◈',
    order: 0,
    component: OverviewPage,
  })
  stopWatch = watch(
    items,
    (pages) => {
      for (const [id, record] of removers) {
        if (entries.get(id) !== record.page) {
          record.dispose()
          removers.delete(id)
        }
      }
      for (const page of pages) {
        if (removers.has(page.id)) continue
        const dispose = ctx.page({
          path: `/admin/${page.id}/`,
          name: page.title,
          component: component(page),
        })
        removers.set(page.id, { page, dispose })
      }
    },
    { immediate: true, flush: 'sync' },
  )
  const overview = entries.get('overview')!
  ctx.page({ path: '/admin/', name: '管理控制台', component: component(overview) })
}
export default apply
