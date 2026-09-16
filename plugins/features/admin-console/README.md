# 管理控制台

默认挂载在 `/admin`（同时支持 `/admin/`），提供概览、分组导航和可折叠的图标菜单。进入后台必须具备系统范围的 `admin.console.view`，此权限默认授予 `admin` 角色。所有后台页面跳转都会重新请求服务端校验，访客跳转认证提供者的登录页，登录后返回目标页面。

## 页面插槽

其他 WebUI 插件依赖此包，使用客户端契约注册独立 Vue 页面：

```typescript
import { registerAdminPage } from '@antarestra/plugin-admin-console/client'
import type { ClientPlugin } from '@antarestra/webui/client'
import ExamplePage from './ExamplePage.vue'

const apply: ClientPlugin = (ctx) => {
  registerAdminPage(ctx, {
    id: 'example-settings',
    title: '示例设置',
    group: '系统设置',
    icon: '◇',
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
