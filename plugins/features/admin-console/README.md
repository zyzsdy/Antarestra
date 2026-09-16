# 管理控制台

默认挂载在 `/admin`（同时支持 `/admin/`），提供概览、分组导航和可折叠的图标菜单。进入后台必须具备系统范围的 `admin.console.view`，此权限默认授予 `admin` 角色。访客跳转认证提供者的登录页，登录后返回目标页面。

登录响应返回系统范围的权限列表，页面壳在 localStorage 中保存展示快照（账号标识、显示名称、账号页路径、过期时间和权限列表），不保存令牌。菜单与路由守卫只读取本地快照，不发起专用鉴权请求。缺少快照时进入账号中心；已有 Cookie 的用户可通过账号资料接口恢复快照。过期、退出和真实 API 返回 401 时清除快照；其他标签页的变更通过 storage 事件同步。

控制台不提供 `/api/admin-console/session`。权限变化后可进入账号中心重新读取资料，或重新登录更新快照；真实 API 始终独立鉴权，因此旧快照或手工修改 localStorage 都不能越权。API 返回 403 时保留当前页面并显示错误，不再额外请求鉴权接口。

切页复用控制台组件，不再清空访问状态。无权限的菜单不展示，直接输入无权页面地址会进入访问受限页。页面卸载仍取消正在进行的业务请求，快速离开尚未加载完成的页面时出现取消属于正常行为。扩展批量注册后仅在当前路由匹配变化时重新匹配，避免无关页面注册反复触发守卫。

## 页面插槽

其他 WebUI 插件依赖此包，使用客户端契约注册独立 Vue 页面：

```typescript
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import type { ClientPlugin } from '@antarestra/webui/client'
import { Cog6ToothIcon } from '@antarestra/webui/icons'
import ExamplePage from './ExamplePage.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'example-settings',
    title: '示例设置',
    group: '系统设置',
    icon: Cog6ToothIcon,
    component: ExamplePage,
    permission: 'example.settings.view',
    order: 100,
  })
}
export default apply
```

页面位于 `/admin/example-settings/`。`id` 只接受小写字母开头的字母、数字和短横线；重复标识拒绝注册。`permission` 是可选的附加系统权限，须由所属后端插件声明。页面菜单不是业务授权凭据，业务 API 必须独立检查身份、权限与空间范围。

底层使用 WebUI 的 `admin-console.pages` 插槽，支持贡献先于宿主加载、动态加入及独立卸载；贡献随所属插件卸载回收。后台自身卸载会移除页面、导航守卫和监听，重新启用后可重新读取仍存在的贡献。未启用后台时贡献不会挂载页面。

auth-local 提供“用户与权限”分组，包含本地用户、角色与权限、角色分配；多个认证实例以实例标识区分路由及分组。
