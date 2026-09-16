import { computed, defineComponent, h, reactive, watch } from 'vue'
import type { ClientPlugin } from '@antarestra/webui/client'
import { Squares2X2Icon } from '@antarestra/webui/icons'
import { adminPagesSlot, registerAdminPage } from '../src/client.js'
import type { AdminPage } from '../src/client.js'
import ConsoleLayout from './ConsoleLayout.vue'
import OverviewPage from './Page.vue'

const apply: ClientPlugin = (ctx) => {
  const loginPath = typeof ctx.config.loginPath === 'string' ? ctx.config.loginPath : '/auth/user/'
  const entries = ctx.slot<AdminPage>(adminPagesSlot)
  const items = computed(() =>
    [...entries.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
    ),
  )
  const visibleItems = computed(() =>
    items.value.filter(
      (page) =>
        !page.permission || ctx.session.snapshot.value?.permissions.includes(page.permission),
    ),
  )
  const state = reactive({
    collapsed: typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches,
  })
  const removers = new Map<string, { page: AdminPage; dispose: () => void }>()
  let stopWatch: (() => void) | undefined
  const stopGuard = ctx.router.beforeEach((to) => {
    if (!/^\/admin(?:\/|$)/i.test(to.path)) return
    const session = ctx.session.read()
    if (!session)
      return {
        path: loginPath,
        query: { returnTo: to.fullPath },
      }
    if (to.path.toLowerCase().replace(/\/$/, '') === '/admin/access-denied') return
    const page = items.value.find(
      (item) => to.path.toLowerCase().replace(/\/$/, '') === `/admin/${item.id}`,
    )
    if (
      !session.permissions.includes('admin.console.view') ||
      (page?.permission && !session.permissions.includes(page.permission))
    )
      return { path: '/admin/access-denied/', query: { returnTo: to.fullPath } }
    // 仅做展示层防误入；真实数据权限由每个业务 API 独立校验。
  })
  ctx.effect(() => () => {
    stopWatch?.()
    stopGuard()
    for (const record of removers.values()) record.dispose()
    removers.clear()
  })
  const component = defineComponent(() => () => {
    const path = ctx.router.currentRoute.value.path.toLowerCase().replace(/\/$/, '')
    const page =
      items.value.find((item) => path === `/admin/${item.id}`) ?? entries.get('overview')!
    const session = ctx.session.snapshot.value
    const allowed =
      path !== '/admin/access-denied' &&
      !!session?.permissions.includes('admin.console.view') &&
      (!page.permission || session.permissions.includes(page.permission))
    return h(ConsoleLayout, {
      actorId: session?.actorId ?? '',
      displayName: session?.displayName ?? '',
      accountPath: session?.accountPath ?? loginPath,
      ready: !!session?.permissions.includes('admin.console.view'),
      failure: !session
        ? '登录状态已失效，请重新登录。'
        : allowed
          ? ''
          : '没有访问此页面的权限。请联系管理员，权限更新后可重新登录。',
      collapsed: state.collapsed,
      page,
      items: visibleItems.value,
      router: ctx.router,
      onToggle: () => {
        state.collapsed = !state.collapsed
      },
    })
  })
  registerAdminPage(ctx, {
    id: 'overview',
    title: '控制台概览',
    group: '工作台',
    icon: Squares2X2Icon,
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
        const dispose = ctx.page({ path: `/admin/${page.id}/`, name: page.title, component })
        removers.set(page.id, { page, dispose })
      }
    },
    { immediate: true, flush: 'sync' },
  )
  ctx.page({ path: '/admin/', name: '管理控制台', component })
  ctx.page({ path: '/admin/access-denied/', name: '访问受限', component })
}
export default apply
