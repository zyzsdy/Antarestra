import { defineComponent, h } from 'vue'
import type { ClientPlugin } from '@antarestra/webui/client'
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import AccountPage from './AccountPage.vue'
import UsersPage from './UsersPage.vue'
import RolesPage from './RolesPage.vue'
import BindingsPage from './BindingsPage.vue'
import './style.css'

const apply: ClientPlugin = (ctx) => {
  const base = String(ctx.config.base)
  const providerId = base.split('/').at(-1)!
  ctx.page({
    path: String(ctx.config.path),
    name: String(ctx.config.title),
    component: defineComponent(
      () => () =>
        h(AccountPage, { base, allowRegistration: ctx.config.allowRegistration === true }),
    ),
  })
  const group = providerId === 'local' ? '用户与权限' : `用户与权限 · ${providerId}`
  for (const page of [
    {
      id: 'users',
      order: 100,
      title: '本地用户',
      icon: '◎',
      permission: 'identity.local.manage',
      component: defineComponent(() => () => h(UsersPage, { base })),
    },
    {
      id: 'roles',
      order: 110,
      title: '角色与权限',
      icon: '◇',
      permission: 'authz.role.manage',
      component: RolesPage,
    },
    {
      id: 'bindings',
      order: 120,
      title: '角色分配',
      icon: '♧',
      permission: 'authz.binding.manage',
      component: BindingsPage,
    },
  ])
    registerAdminPage(ctx, { ...page, id: `auth-${providerId}-${page.id}`, group })
}
export default apply
