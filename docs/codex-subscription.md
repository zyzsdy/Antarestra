# ChatGPT / Codex 订阅接入

## 开始使用

本功能位于现有 `@antarestra/plugin-ai-provider` 插件中，默认配置已启用，无需另外安装插件。

1. 构建并启动 Antarestra，使用管理员账户进入 **管理控制台 → AI 设置 → ChatGPT 订阅**。
2. 点击 **使用 ChatGPT 继续**，再打开官方授权页面。使用自己的 ChatGPT 账户登录，并允许 Antarestra 使用订阅。
3. 服务端与浏览器在同一台电脑上时，回调自动完成。远程自托管时，如果浏览器跳转到 `127.0.0.1` 后显示无法连接，复制地址栏中的完整回调地址，粘贴到面板后点击 **完成授权**。也可将面板显示的回调端口通过 SSH 转发到服务端。
4. 完成后自动获取该账户允许展示的模型。如果目录请求失败，授权仍然保留，可点击 **同步模型**重试。
5. 在聊天或 Agent 的模型选择中选择 **ChatGPT 订阅 · 账户标识后八位**。如 Agent 限定了模型列表，需要将对应模型加入其列表。

授权链接有效期为 10 分钟。不要把回调地址发给其他人；其中包含短期授权码。多个 ChatGPT 账户分别保存为独立提供商，不进行账号轮换或额度池化。

## 是否需要申请 Key

**不需要申请 API Key，也不需要手动注册 OAuth 客户端。** 当前官方面向开源、本地运行及自托管应用的流程通过 `dynamic_agent_client` 动态注册，在授权回调中返回该用户的 `oaiapp_…` 客户端 ID。这是公开标识，不是 API Key 或 client secret。插件自动保存它，并在重新授权与刷新时复用。

需要一个具备官方订阅使用资格的 ChatGPT 账户，并在官方授权页面同意所请求的范围。可用模型、套餐资格、额度和组织策略由 OpenAI 决定；本地登录成功不代表该账户已经获得所有模型或无限额度。使用面板的 **在 ChatGPT 中查看用量与管理应用额度** 查看官方状态。

如果准备把应用作为收费或代用户托管的公共服务运营，官方文档将其与开源自托管流程区分，需通过其合作意向入口确认接入资格。普通 OpenAI API Key 属于另一套 API 用量计费方式，不能当作本功能的订阅授权替代。

依据：[官方接入概览](https://developers.openai.com/siwc/token-sharing-open-source)、[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。核对日期：2026 年 11 月 12 日。

## 请求与支持范围

请求直接发送到 `https://api.openai.com/v1/responses`，不经过中转服务。使用官方 OAuth 访问令牌，强制 `store: false`、`stream: true`，历史由 Antarestra 提供；只在收到 `response.completed` 时认定请求完成。

复用现有 Responses 驱动处理文本、思考、工具调用、图片及可内联的文件。函数工具使用命名空间，系统指令转换为 developer 消息，移除官方订阅端点不支持的参数。需要 Files API 上传的办公文档会明确拒绝，可转换为 PDF 或文本。模型是否接受图片仍以其能力目录为准。

额度面板链接到 ChatGPT 官方用量页。当前官方公开文档没有提供可供本插件读取的额度百分比接口，因此不从私有 `backend-api` 抓取或估算剩余额度。DSH 专属远程控制、绘图与语音工作区未引入；这里移植的是账户授权、凭据生命周期、订阅模型接入和对应管理界面。

参考：[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[账户与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)。

## 凭据与生命周期

- 凭据目录默认是相对服务工作目录的 `data/codex-subscription`，由插件配置 `codexCredentialsDirectory` 调整。目录不通过 WebUI 静态服务发布。
- `accounts.json` 包含主机 ID、已验证的账户身份、客户端 ID、模型及令牌；令牌以明文保存在服务端私有文件，不放入业务提供商数据库或浏览器存储。Unix 新建目录权限为 `0700`，凭据文件为 `0600`，通过临时文件与重命名原子替换。Windows 部署需由操作系统目录 ACL 限制服务账户访问，文件 mode 不替代 Windows ACL。
- 默认 `data/` 已被 Git 忽略。自定义目录也必须排除版本管理，不能指向公共静态目录。备份时按敏感凭据保护；复制部署时不要把旧主机凭据目录作为新主机初始目录。
- 一个目录只允许一个进程使用。插件正常卸载会释放 `.lock`。若进程被强制结束，先确认旧进程已停止，再移除残留 `.lock`；不要在运行时删除锁文件。
- 授权使用 PKCE S256、随机 state 与 nonce；通过官方 JWKS 验证 ID token 签名、issuer、audience、有效期及身份一致性。回调只能消费一次。
- 同一账户的访问令牌在调用前按需刷新，轮换后的访问令牌与刷新令牌一起持久化。拒绝跨用户读取、同步、断开账户及模型凭据使用；模型运行的工作空间仍由核心解析和校验。
- **断开订阅**先停止该提供商的运行，再尝试撤销远端刷新会话并清理本地令牌。客户端 ID 与账户标识保留，便于之后重新授权。远端撤销无法确认时会明确提示到 ChatGPT 设置中断开应用。
- 卸载、依赖失效和热重载会取消网络请求、关闭回环监听、回收模型注册并释放目录锁。主机 ID 与账户注册在重启后保持稳定。

## 移植来源与验证

参考 [WSL043/dsh-codex-subscription](https://github.com/WSL043/dsh-codex-subscription/tree/fb37c50a128aed84b230c520bf934cded97d851b) 的账户隔离、登录协调、设置面板与订阅连接职责。按 Antarestra 的 Cordis 4、Vue SFC、RBAC 与提供商契约重新实现，未引入 DSH 的 React 面板或运行时依赖；OAuth 与推理采用当前官方开源应用接口。

针对性测试入口：

```sh
pnpm exec vitest run tests/integration/codex-subscription.test.ts tests/integration/ai-provider.test.ts tests/integration/provider-images.test.ts tests/integration/provider-google.test.ts tests/integration/provider-user-agent.test.ts tests/integration/provider-model-sync.test.ts
pnpm --filter @antarestra/plugin-ai-provider typecheck
pnpm --filter @antarestra/plugin-ai-provider build
```

测试使用本地 SQLite、真实回环 HTTP 回调、测试签名的 JWT 和模拟官方响应，包含流式文本、工具和图片输入验证，不消耗真实订阅。真实账户登录和推理需要部署后由账户持有人完成；不能将这些测试称为真实模型集成测试。
