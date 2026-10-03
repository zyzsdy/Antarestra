# 插件开发入口

当前插件模式适合在工作区内开发、装配和热更新。独立第三方包可以由加载器解析，但 SDK 与定义包目前均为 `private` 工作区包，模板依赖仓库相对路径；仓库尚未建立公开发布、版本兼容与外部安装验收流程。不要把仓内模板直接当作可独立发布的 npm 项目。

## 选择扩展位置

| 要扩展的能力                          | 接入方式                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| 通用服务                              | 定义包暴露服务契约，实现包注册能力；消费者依赖定义包                                      |
| AI 工具、模型驱动、运行后端、资源解析 | 注入 `ai` 并调用对应 `register*`，参见 [AI 核心](../plugins/definitions/ai/README.md)     |
| HTTP API                              | 注入 `server`，经所属上下文注册路由；受保护业务另注入 `rbac` 并校验权限与空间             |
| 网页或后台页面                        | 使用 WebUI 模板，通过客户端页面或后台插槽扩展                                             |
| IM 平台                               | 实现 [IM 接入契约](../plugins/definitions/im/README.md)，复用身份、命令与 AI 业务         |
| Markdown 代码块                       | 注册 [Markdown 渲染扩展](../plugins/features/markdown-render/README.md)，不复制整个解析器 |

先检查项目已有服务及 Cordis 能力，优先复用。`plugins/` 只放由配置加载的插件；启动器直接使用的基础设施放在 `packages/`。

## 最小服务端插件

```typescript
import type { Context } from '@antarestra/plugin-sdk'
import type {} from '@antarestra/plugin-server'
import type {} from '@antarestra/rbac'

export const inject = ['server', 'rbac']

export function apply(ctx: Context) {
  ctx.rbac.registerPermission(ctx, 'example.status.view', '查看示例状态', ['admin'])
  ctx.server.route(
    ctx,
    'GET',
    '/example/status',
    ctx.rbac.require('example.status.view'),
    (http) => {
      http.body = { status: 'ok' }
    },
  )
}
```

对应地址为 `/api/example/status`。包应直接声明 SDK 和所消费服务的依赖，不依赖根目录偶然提升的模块；ESM 相对导入使用 `.js` 后缀。默认导出函数、服务类、插件对象和命名 `apply` 都可加载。

所有插件清单包含 `keywords: ["antarestra-plugin"]`。用 `antarestra.title`、`configSchema` 和 `multipleInstances` 描述名称、静态 JSON Schema 路径及多实例能力；默认单实例。Schema 是表单和服务端配置校验的共同契约，敏感字段添加 `x-sensitive: true`。完整格式见[插件设置面板](../plugins/features/config-panel/README.md)。

## 装配和生命周期

1. 通过 `pnpm --filter 目标包 add 包名` 添加真实依赖；内部包使用 `@workspace:*`。新增服务端包同步项目引用、构建脚本及 `development` / 默认导出。
2. 安装到 server 可解析范围，例如 `pnpm --filter @antarestra/server add '@antarestra/plugin-example@workspace:*'`；随后在主配置启用。加载器无须手写别名表。
3. 通过 `inject` 或局部 `ctx.inject()` 声明服务依赖。界面注册可放进只依赖 WebUI 的子插件，避免网页服务失效连带停止后台能力。
4. 注册方法显式传入调用方 `ctx`，资源用 `ctx.effect()` 绑定回收。等候就绪用 `await ctx.plugin()`；卸载用 `await fiber.dispose()`。
5. 验证重复标识、独立卸载、依赖撤销与恢复、多实例隔离、异步初始化中卸载和晚到资源清理。

配置文件中的实例键、业务后端/提供商 ID、Cordis Fiber 编号是不同概念。只加随机实例后缀不能让单例服务自动支持多实例。只声明依赖也不能代替所选后端就绪检查。

## 网页插件

```powershell
pnpm create:webui example
```

按生成器提示安装工作区依赖、加入 server 装配并启用。页面写在 `client/*.vue`，入口只负责注册；使用 `@antarestra/webui/vite`，共享 Vue、Router、Reka UI 和样式生命周期。前端开发单独执行 `pnpm --filter @antarestra/plugin-example dev`。

模板页面默认公开。路由守卫和菜单隐藏只是界面行为，API 必须在服务端授权。`addEntry()` 的配置和资源是公开内容，不放凭据。组件、插槽和后台贡献见 [WebUI](../plugins/definitions/webui/README.md) 与 [admin-console](../plugins/features/admin-console/README.md)。

## 可信代码与稳定契约

插件拥有宿主 Node.js 权限。工作空间、数据库命名空间、工具白名单和 Schema 都不隔离恶意代码；安装来源必须可信。工具应遵守 `AbortSignal`，自行管理外部副作用的并发与重试；运行取消不撤销已经完成的外部操作。

资源操作应通过核心授权句柄或 `authorizeRunContext()` 再检查空间。当前核心尚未统一保证活动 Run 中的身份撤销立即阻止下一次工具调用，第三方工具不能据此省略自身授权复核。具体缺口见[整体评审](reviews/2026-10-03.md)。

面向独立插件生态的下一步是发布 SDK/定义包、提供脱离本仓库的模板、声明兼容版本及共享运行时策略，并以“打包 → 外部安装 → 发现 → 加载 → 卸载”作为验收链路。
