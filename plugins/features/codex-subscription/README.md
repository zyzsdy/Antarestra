# ChatGPT 订阅接入插件

`@antarestra/plugin-codex-subscription` 通过官方 OAuth 接入用户自己的 ChatGPT 订阅，独立管理授权回调、凭据刷新、账户模型、HTTP 管理接口及控制台页面。无需启用 `ai-provider`。

插件注入 `ai`、`rbac`；存在 `server` 时注册 `/api/codex-subscription` 接口，存在 `webui` 时注册独立客户端入口。管理页面位于 **管理控制台 → AI 设置 → ChatGPT 订阅**，路径为 `/admin/codex-subscription/`。管理接口要求 `admin.console.view` 与 `admin.ai.codex.manage`，账户按登录主体隔离。

```yaml
plugins:
  codex-subscription:
    credentialsDirectory: data/codex-subscription
    proxy: socks5://127.0.0.1:7890
```

`proxy` 可在插件配置面板中设置，支持 HTTP、HTTPS 和 SOCKS5 代理，例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:7890`；省略或留空保持原有网络行为。配置后，插件全部服务端出站请求（授权码交换、令牌刷新、身份公钥、模型目录、模型流式响应、撤销授权及其发现请求）均通过代理，代理不可用时请求失败，不回退直连。代理连接随插件卸载关闭，不影响其他插件。浏览器打开的登录页面使用浏览器自己的网络配置，本地 OAuth 回调监听不经过代理。代理地址中的 `127.0.0.1` 指运行 Antarestra 的服务器；包含代理凭据时请使用环境引用，勿提交真实凭据。

默认主配置已启用本插件。凭据目录默认保持原路径；从旧版升级时，将 `ai-provider.codexCredentialsDirectory` 移至本插件的 `credentialsDirectory`。保留原目录即可沿用账户、客户端 ID、主机 ID 和令牌，无需重新登录。

模型传输复用 `@antarestra/ai-model-driver`，订阅请求限制由本插件提供。正常卸载或依赖失效会取消请求、关闭回环监听、释放目录锁和回收模型能力，不影响普通提供商。

授权步骤、无需申请 Key 的说明、远程部署和凭据保护详见[订阅接入指南](../../../docs/codex-subscription.md)。

账户卡片的“网页搜索设置”支持独立开关和显式模型范围，默认关闭。启用后，助理可选择该账户的 `provider:账户ID:web_search`；允许全部工具的助理自动包含它。模型同步不扩大授权范围，关闭、重新授权及重启保留配置。保存设置会停止该账户正在进行的模型调用；实际搜索可用性由 OpenAI 决定。详见[原生网页搜索](../../../docs/codex-subscription.md#原生网页搜索)。
