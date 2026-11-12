# 共享模型驱动

`@antarestra/ai-model-driver` 是由模型接入插件调用的基础设施包，不是由主配置加载的 Cordis 插件。它负责协议适配、流式响应、历史签名、附件转换、原生文件上传清理和内置模型目录。

`createModelDriver(provider, options)` 接收连接描述和明确的驱动 ID。凭据由 AI 核心在请求时解析，驱动不管理账户存储。调用插件通过可选策略提供工具额度预占、附件校验、请求参数转换和完成事件校验；共享包不依赖任何功能插件、数据库或 OAuth 实现。

- `ai-provider` 管理普通提供商配置、远端模型同步和数据库工具额度。
- `codex-subscription` 管理订阅 OAuth、凭据、账户模型和订阅协议限制。

两个功能插件均通过 `@antarestra/ai` 注册模型能力，能够独立启停。浏览器所需的类型和默认模型限制从 `@antarestra/ai-model-driver/types` 导入，避免把服务端驱动带进网页构建。
