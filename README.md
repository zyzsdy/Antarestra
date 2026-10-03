# Antarestra

Antarestra 是面向多用户、多助理的 AI 运行平台，提供网页聊天、IM 接入、模型与工具管理，以及持久化的对话、文件和记忆。项目使用 TypeScript、Vue 和 pnpm workspace，以 Cordis 管理插件的依赖、激活与资源回收。

架构的核心是把**助理配置、单次运行、模型驱动和入口协议分开**：AI 核心负责授权、运行快照、工具调用、上下文与历史；执行后端和模型提供商通过项目接口接入；网页及 IM 复用这些能力。插件在同一进程中组合，所有数据访问仍须校验工作空间。当前是模块化单进程系统，插件代码必须可信。详见[架构与边界](docs/architecture.md)。

## 开始使用

环境要求：**Node.js 24、pnpm 11.7.0**。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

按[启动与开发指南](docs/development.md)准备独立配置、初始化管理员，再启动服务。指南提供不依赖外部数据库的 SQLite 最小配置；记忆、对象存储和 IM 可分别接入。`antarestra.yml` 是默认加载文件，使用前需检查其中的连接与凭据配置。

服务启动后，默认端口为 `14451`：

- [网页聊天](http://127.0.0.1:14451/)：登录后选择助理和模型。
- [账号中心](http://127.0.0.1:14451/auth/user/)：登录、注册（需启用）和修改密码。
- [管理控制台](http://127.0.0.1:14451/admin/)：管理提供商、助理、账号、插件与接入。
- [健康接口](http://127.0.0.1:14451/api/health)：确认 HTTP 服务在线；不代表所有插件就绪。

首次聊天需要在控制台配置至少一个可用模型；`ai-agents` 提供内置默认助理。外部提供商通常需要自己的凭据，本地兼容服务可按其要求免 Key。

## 功能索引

| 能力           | 已实现内容                                                                           | 详细文档                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 网页聊天       | 流式回复、工具与思考详情、历史分支、编辑与重新生成、归档与永久删除、图片和文件附件   | [聊天界面](plugins/features/chat-webui/README.md)                                                                                                                                                                                                                                                                                                                              |
| AI 运行        | 版本化助理、运行快照、幂等与取消、工具并行调用、持久事件与 SSE、上下文预算及自动压缩 | [AI 核心](plugins/definitions/ai/README.md)、[执行后端](plugins/implementations/ai-agent-core/README.md)                                                                                                                                                                                                                                                                       |
| 模型与助理管理 | 多提供商连接、模型目录、协议驱动、提供商内置工具、提示词模板和能力选择               | [提供商](plugins/features/ai-provider/README.md)、[助理](plugins/features/ai-agents/README.md)                                                                                                                                                                                                                                                                                 |
| 账号与权限     | 本地账号、会话、角色权限、个人空间、IM 主体和群空间映射                              | [本地认证](plugins/implementations/auth-local/README.md)、[RBAC](plugins/definitions/rbac/README.md)、[IM 身份](plugins/implementations/identity-im/README.md)                                                                                                                                                                                                                 |
| IM 对话        | OneBot 11 反向 WebSocket、飞书长连接、群聊/私聊触发、命令、身份映射、接入管理        | [IM 服务](plugins/definitions/im/README.md)、[OneBot](plugins/adapters/im-onebot/README.md)、[飞书](plugins/adapters/im-feishu/README.md)、[AI 对话](plugins/features/im-ai/README.md)、[命令](plugins/features/im-commands/README.md)、[控制台](plugins/features/im-console/README.md)                                                                                        |
| 文件与附件     | 工作空间文件、目录和配额、S3 兼容存储、上传下载、模型读取和文件工具                  | [工作空间文件](plugins/features/workspace-file/README.md)、[存储接口](plugins/definitions/storage/README.md)、[S3 / RustFS](plugins/implementations/storage-s3/README.md)                                                                                                                                                                                                      |
| 记忆与定时任务 | 空间共享记忆、预算整理、中英文全文检索、持久化定时唤醒与周期任务                     | [记忆](plugins/features/memory/README.md)、[唤醒任务](plugins/features/wake-tasks/README.md)                                                                                                                                                                                                                                                                                   |
| 模型工具       | 时间与时区、Todo、网页搜索、阅读、交互、PDF 和截图                                   | [基础工具](plugins/features/basic-tools/README.md)、[网页工具](plugins/features/web-tools/README.md)                                                                                                                                                                                                                                                                           |
| 插件运维       | 在线配置、启停、实例状态、配置 Schema 表单、授权重启、开发热更新                     | [插件设置](plugins/features/config-panel/README.md)、[HMR](plugins/features/hmr/README.md)                                                                                                                                                                                                                                                                                     |
| 网页扩展       | Vue SFC 插件、共享 Vue / Reka UI、路由与插槽、后台页面、可扩展 Markdown 渲染         | [WebUI](plugins/definitions/webui/README.md)、[后台](plugins/features/admin-console/README.md)、[Markdown 插件](plugins/features/markdown-render/README.md)、[解析与渲染库](packages/markdown/README.md)                                                                                                                                                                       |
| 基础服务       | HTTP/HTTPS、数据库迁移、多数据库方言、请求代理、隔离浏览器上下文、日志               | [Server](plugins/adapters/server/README.md)、[数据库接口](plugins/definitions/database/README.md)、[数据库实现](plugins/implementations/database-kysely/README.md)、[HTTP](plugins/definitions/http/README.md)、[Playwright](plugins/definitions/playwright/README.md)、[Puppeteer](plugins/definitions/puppeteer/README.md)、[日志](plugins/implementations/logger/README.md) |

## 开发与扩展

- [启动与开发指南](docs/development.md)：本地环境、数据库、构建监听、测试和运行配置。
- [插件开发入口](docs/plugin-development.md)：包结构、依赖注入、注册回收、配置元数据和第三方接入边界。
- [配置加载器](packages/config-loader/README.md)：配置路径、环境变量、多实例与包名解析。
- [插件 SDK](packages/plugin-sdk/README.md)：统一 Cordis 入口与带生命周期的注册表。
- [架构与边界](docs/architecture.md)、[领域词汇](CONTEXT.md)、[AI 核心决策](docs/adr/0001-ai-core.md)。
- [协作约定](AGENTS.md)、[界面规范](DESIGN.md)、[交互契约](UX-CONTRACT.md)。

新增 WebUI 插件使用 `pnpm create:webui <名称>`。依赖统一通过 `pnpm add` / `pnpm remove` 管理；插件从 `@antarestra/plugin-sdk` 导入 Cordis，当前固定为 `cordis@4.0.0-rc.10`。

## 当前边界

已具备持久化聊天和真实模型驱动，但安装成功不代表所有外部服务均已配置或经过真实账号验证。Skill 已有注册与授权契约，仓库尚未提供独立的 Skill 加载实现；MCP、网站嵌入授权、插件市场、不可信插件沙箱、多副本运行协调和向量检索尚未实现。IM 定时任务可以恢复身份，但唤醒结果自动推送原群尚未完成。

第三方插件目前主要面向本仓库开发与自行安装，尚无正式 SDK 发布及兼容性承诺。插件管理权限可以修改运行配置，应视为完全可信的系统管理权限。上线前请阅读[整体代码评审](docs/reviews/2026-10-03.md)，其中记录了本次确认的安全缺口、解耦问题及验证范围。
