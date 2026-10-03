# 插件 SDK

`@antarestra/plugin-sdk` 统一转导出 `cordis@4.0.0-rc.10` 的运行时与类型，并提供少量生命周期和配置辅助。插件应从 SDK 导入 `Context`、`Service`、`Plugin`、`Fiber` 等，不直接引入另一个 Cordis 运行时。

## 服务与事件

服务类型扩展声明在 SDK 模块上：

```typescript
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'

declare module '@antarestra/plugin-sdk' {
  interface Context {
    example: ExampleService
  }
}

export default class ExampleService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'example')
  }
}
```

SDK 的 `Events` 扩展桥接到 Cordis 原生事件系统；使用 `ctx.on()`、`ctx.serial()`、`ctx.parallel()` 等方法，不另外实现全局事件总线。消费者仍需声明 `inject`，类型扩展不表示服务已经存在。

## ScopedRegistry

`ScopedRegistry<T>` 提供 `register(owner, id, value)`、`get(id)` 和 `list()`。注册项归属于传入上下文，空标识和重复标识拒绝注册；返回的回收函数可等待且幂等，插件卸载自动撤销。能力不存在时 `get()` 抛错。

它是简单注册表，不负责业务授权、异步资源清理、运行快照或工具覆盖栈。AI 等有更丰富语义的服务使用自己的注册契约，调用方不应绕过它们直接写内部集合。

## 辅助入口

- `@antarestra/plugin-sdk/schema`：`schemaConfig()`、`validateConfig()`、静态 JSON Schema 读取和环境值类型转换。
- `@antarestra/plugin-sdk/loader`：插件加载管理与状态相关契约。
- `@antarestra/plugin-sdk/hmr`：协调当前 Cordis HMR 和配置管理生命周期的适配。

加载器和 HMR 入口用于宿主集成，一般业务插件无需依赖。升级 Cordis、Node 或 HMR 后应验证兼容行为；当前 HMR 使用 Node 内部模块缓存能力。

SDK 当前为私有工作区包，没有公开发行或跨版本兼容承诺。完整开发步骤见[插件开发入口](../../docs/plugin-development.md)，配置表单见[插件设置面板](../../plugins/features/config-panel/README.md)。
