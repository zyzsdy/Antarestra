# Web 聊天界面

`@antarestra/plugin-chat-webui` 依赖 WebUI、RBAC 与 Server，向 WebUI 注册 `/`，默认随主配置加载。

进入页面前请求 `/api/chat-webui/session`，服务端通过 RBAC 的 `web` 通道解析 actorId 和 workspaceId，并验证 `chat.webui.view`（使用Web聊天界面，默认角色 `user`、`admin`）。未登录返回 401 与认证提供者登录路径，前端跳转登录；已登录无权限返回 403，不渲染聊天布局。未知通道和网络故障不会放行。

界面包含历史记录侧栏、个人工作空间、用户入口、欢迎区和禁用的消息输入框。窄屏通过按钮展开侧栏。公共提示通过 Vue inject 获取 WebUI 的交互服务。

本次只实现界面与授权入口，不保存聊天记录、不调用模型、不提供发送接口。历史列表保持空态，不生成伪造对话。未来聊天存储与资源接口必须使用服务端解析出的 workspaceId 进行过滤和授权；当前入口已拒绝通过查询参数切换到其他空间。重新聚焦页面时重新验证身份，身份或空间改变后刷新页面。

## 前端开发

`client/ChatPage.vue` 使用标准 Vue SFC，样式位于 `client/chat.css` 并通过 `<style scoped src="./chat.css">` 引入。`client/index.ts` 保留路由守卫、会话状态和插件清理逻辑。

`vite.config.ts` 使用 `@antarestra/webui/vite` 的共享配置，组件直接从 `vue` 导入 API；构建时复用页面壳的运行时，CSS 链接随扩展上下文回收。运行 `pnpm --filter @antarestra/plugin-chat-webui dev` 监听 SFC 与 CSS 修改，配合 HMR 插件更新页面。
