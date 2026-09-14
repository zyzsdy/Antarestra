# WebUI 定义与页面扩展

`@antarestra/webui` 提供 `ctx.webui`、浏览器端页面契约和默认 Vue 页面壳。它依赖 `server`，构建产物位于本包 `public/`，通过 `ctx.server.static(ctx, '/', directory)` 在同一个 HTTP 端口提供首页。项目不再使用独立的 `apps/web`。

## 后端注册

消费插件声明 `inject: ['webui']`，通过所属上下文注册客户端入口：

```typescript
ctx.webui.addEntry(ctx, {
  id: 'example',
  directory: fileURLToPath(new URL('../public/', import.meta.url)),
  config: { title: '示例页面' },
})
```

目录必须包含构建后的 ES 模块 `index.js`。每次注册分配独立资源 URL，卸载自动回收清单与静态挂载；重复标识拒绝注册。目录只应包含可公开资源，`config` 只允许放入公开客户端配置，不能包含凭据。`/webui/entries.json` 是公开扩展清单，不代表用户已获得业务权限。

## 浏览器注册

浏览器模块默认导出一个接收 `ClientContext` 的函数。后端不传输 Vue 对象。客户端扩展共享页面壳提供的 `ctx.vue`，不会打包第二份 Vue 运行时：

```typescript
import type { ClientPlugin } from '@antarestra/webui/client'

const apply: ClientPlugin = (ctx) => {
  const { defineComponent, h } = ctx.vue
  ctx.page({
    name: '示例页面',
    path: '/example/',
    component: defineComponent({
      setup: () => () => h('p', '欢迎使用'),
    }),
  })
  ctx.effect(() => {
    const timer = setInterval(() => {}, 1000)
    return () => clearInterval(timer)
  })
}
export default apply
```

页面路径为带结尾斜杠的普通路径，根路径、API 和 WebUI 资源前缀保留；重复页面路径拒绝注册。导航自动生成，支持浏览器前进后退、直达与刷新。页面组件使用 Vue 自身的挂载和卸载钩子管理页面资源，扩展级副作用使用 `ctx.effect()`。入口初始化失败时回收已注册内容并显示错误，其余入口继续加载。

浏览器每 3 秒重新获取清单，扩展卸载或入口版本变化时回收页面和副作用。当前实现页面与生命周期契约；未实现 Slot、前端服务依赖注入或 WebSocket 数据服务。所有业务请求仍通过各自 API 及服务端授权检查。客户端插件属于可信代码，生命周期管理不提供安全沙箱。

## 构建与开发

根目录 `pnpm build` 按依赖顺序构建页面壳和认证扩展。`pnpm dev` 先构建，再启动服务端和两个前端构建监听器，统一访问 <http://localhost:14451/>。`pnpm dev:web` 只重新构建和监听前端，不提供额外 HTTP 端口；修改客户端文件后刷新浏览器查看。

WebUI 可配置 `directory` 为另一套页面壳构建目录；默认无需配置。`/api/*`、扩展资源和带扩展名的缺失文件不执行 HTML 回退。页面导航的未知路径显示页面不可用提示。

默认本地认证页面为 `/auth/user/`；其他 `providerId` 使用 `/auth/user/<providerId>/`，可同时提供多实例页面。账号中心以 Vue 组件挂载现有表单控制器，使用 Shadow DOM 隔离样式，组件卸载时中止请求；认证 API 继续位于 `/api/auth/local/<providerId>/*`。
