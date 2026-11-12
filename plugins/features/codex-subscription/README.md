# ChatGPT 订阅接入插件

`@antarestra/plugin-codex-subscription` 通过官方 OAuth 接入用户自己的 ChatGPT 订阅，独立管理授权回调、凭据刷新、账户模型、HTTP 管理接口及控制台页面。无需启用 `ai-provider`。

插件注入 `ai`、`rbac`；存在 `server` 时注册 `/api/codex-subscription` 接口，存在 `webui` 时注册独立客户端入口。管理页面位于 **管理控制台 → AI 设置 → ChatGPT 订阅**，路径为 `/admin/codex-subscription/`。管理接口要求 `admin.console.view` 与 `admin.ai.codex.manage`，账户按登录主体隔离。

```yaml
plugins:
  codex-subscription:
    credentialsDirectory: data/codex-subscription
```

默认主配置已启用本插件。凭据目录默认保持原路径；从旧版升级时，将 `ai-provider.codexCredentialsDirectory` 移至本插件的 `credentialsDirectory`。保留原目录即可沿用账户、客户端 ID、主机 ID 和令牌，无需重新登录。

模型传输复用 `@antarestra/ai-model-driver`，订阅请求限制由本插件提供。正常卸载或依赖失效会取消请求、关闭回环监听、释放目录锁和回收模型能力，不影响普通提供商。

授权步骤、无需申请 Key 的说明、远程部署和凭据保护详见[订阅接入指南](../../../docs/codex-subscription.md)。
