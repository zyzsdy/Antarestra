# WebUI 框架与页面扩展

`@antarestra/webui` 只提供 Vue 运行时、Vue Router、扩展生命周期和通用交互组件，不注册首页、业务页面或导航。未注册的路径为空。首页由 `plugin-chat-webui` 注册。

## 后端注册

消费插件依赖 `webui`，调用 `ctx.webui.addEntry(owner, { id, directory, config })` 发布浏览器入口。目录必须包含构建后的 ES 模块 `index.js`；配置和资源均为公开信息，不得包含凭据。扩展清单不代表业务授权。

## 前端注册

浏览器入口默认导出 `ClientPlugin`。通过 `ctx.vue` 共享 Vue，`ctx.router` 使用 Vue Router，`ctx.page({ path, name, component, beforeEnter })` 注册页面和可选异步路由守卫。允许 `/` 和带结尾斜杠的普通路径，保留 `/api/` 与 `/webui/` 前缀。重复路径拒绝注册，卸载时移除路由和组件。

页面使用 Vue 的挂载和卸载钩子回收资源；扩展级副作用使用 `ctx.effect()`。异步初始化失败时自动撤销已注册内容。客户端插件是可信代码，不提供安全沙箱。

## 通用交互

公共服务通过前端 Vue 注入，不挂在后端 Cordis 上下文上：

```typescript
import { feedbackKey } from '@antarestra/webui/client'
import type { ClientPlugin } from '@antarestra/webui/client'

const apply: ClientPlugin = (ctx) => {
  ctx.page({
    path: '/example/',
    name: '示例',
    component: ctx.vue.defineComponent({
      setup() {
        const feedback = ctx.vue.inject(feedbackKey)!
        return () =>
          ctx.vue.h(
            'button',
            {
              onClick: () => feedback.toast('操作完成'),
            },
            '显示提示',
          )
      },
    }),
  })
}
export default apply
```

- `notice(message)`：持续通知，返回关闭函数。
- `toast(message)`：四秒后关闭，返回提前关闭函数。
- `modal(title, message)`、`messagebox(message)`：排队显示对话框，返回确认结果；取消和 Escape 返回 `false`。

通知支持辅助技术播报，对话框使用浏览器原生焦点约束。框架卸载时清理定时器并取消等待中的对话框。

## 构建与开发

`pnpm build` 按依赖顺序构建框架与客户端扩展。服务端在同一端口提供静态资源和 HTML 回退；API、扩展资源和缺失文件不会回退到 HTML。

浏览器首次获取一次清单。启用 `plugin-hmr` 时通过同源 WebSocket 接收扩展更新，替换对应页面并回收副作用；未变化的扩展保留。未启用时需要刷新页面获取新的清单。WebUI 可配置 `directory` 指向其他框架构建目录。

## WebUI SFC 插件模板

新增 WebUI 插件必须从 `pnpm create:webui <名称>` 生成，模板位于 `templates/webui-plugin/`。生成器只接受小写短横线名称，并拒绝覆盖已有目录；随后按命令输出安装依赖、装配服务端并启用配置。

模板使用 `@antarestra/webui/vite` 的 `defineWebUIConfig()`，统一输出 `public/index.js` 和 `public/style.css`。页面用 Vue SFC 编写，可使用 `<script setup lang="ts">`、`<template>`、`<style scoped>` 和独立 CSS 文件。`client/index.ts` 只负责注册页面与插件级生命周期。

组件直接从 `vue` 导入响应式与生命周期 API；构建插件将导入映射到页面壳的同一份 Vue，不能从 `@vue/*` 或 `vue/*` 导入另一套运行时。扩展只能在页面壳中运行。不要自行替换模板构建配置或把 CSS 包装成 JavaScript 字符串；样式链接由构建入口注册，通过 `ctx.effect()` 在扩展卸载、加载失败或更新时回收。CSS 相对资源地址以版本化的扩展目录解析。

运行 `pnpm --filter @antarestra/plugin-<名称> dev` 启动 Vite 构建监听；现有 HMR 插件监视产物并替换整个扩展，不保留组件内状态。修改共享构建工具后需重新构建 `@antarestra/webui` 并重启扩展构建监听。

模板页面是公开的示例计数器。访问业务数据时，必须另行注入 RBAC、声明权限并在服务端校验身份和空间；前端页面路由不承担鉴权。
