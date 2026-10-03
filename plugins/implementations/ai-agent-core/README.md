# AI Agent 循环

`@antarestra/plugin-ai-agent-core` 通过 `@earendil-works/pi-agent-core` 实现具体的 Agent 循环，注入 `ai` 并注册后端 `ai-agent-core`。默认主配置已启用：

```yaml
plugins:
  ai: {}
  ai-agent-core: {}
```

注册 Agent 时设置 `backendId: 'ai-agent-core'`，并指定已注册的模型和工具。插件不自动创建 Agent 或模型连接；模型驱动可以由 `ai-provider` 或其他实现提供。

## 执行边界

- 每次 Run 创建独立的 pi 循环状态，通过 `runtime.request()` 请求模型。系统提示词、历史、模型选择、凭据、流式增量、用量及请求钩子均由 AI 核心处理。
- pi 根据工具调用推进下一轮；同轮所有工具调用通过一次 `runtime.executeTools()` 执行完整批次。参数校验、权限、Skill、超时、工具钩子和结果持久化仍归核心管理，避免重复执行或重复记录事件。
- 工具的业务失败按核心规则反馈模型；核心校验失败、模型调用上限和请求超时保留原始异常并终止 Run。运行取消和依赖卸载使用核心的 AbortSignal。
- 后端注册随插件上下文回收；独立卸载会取消使用它的 Run，`ai` 恢复后由 Cordis 重新注册。

适配内部使用 pi-ai 的消息类型、流工厂与 Schema 工具，不创建模型客户端，也不导入 `ai-provider` 实现。内部模型描述仅用于 pi 循环协议，不用于发送网络请求。pi 内部消息不是持久化历史，完整内容（包括附件资源引用）保留在核心中。

本插件的 pi-agent-core 与 pi-ai 当前清单均使用 `^0.99.1`，实际安装版本由锁文件确定；更新时必须验证两者的消息和流类型兼容性。模型提供商插件通过项目 DTO 和受控运行接口与后端通信，不共享 pi 的运行中对象。

## 验证

`tests/integration/ai.test.ts` 使用此后端与测试模型驱动，覆盖多轮工具、同名工具并发、工具超时、Skill、历史分支、空间隔离、取消、后端卸载和依赖恢复。测试通过 Kysely 使用 SQLite 内存数据库，不需要模型密钥，不代表真实外部模型联调。
