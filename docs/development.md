# 启动与开发指南

## 最小本地环境

使用 Node.js 24、pnpm 11.7.0。下列 PowerShell 命令从仓库根目录执行；Windows 的 Node 与 pnpm 应在已经初始化 fnm 的 PowerShell 7 中运行。

```powershell
pnpm install --frozen-lockfile
pnpm build
```

创建独立配置 `antarestra.dev.local.yml`，写入下面的 YAML，并通过 `--conf` 明确选择它。该文件名匹配仓库的 `*.local.yml` 忽略规则，不覆盖默认主配置。最小配置使用 SQLite，包含网页登录、提供商与助理管理、工具和持久化聊天；不需要 Docker、对象存储或 IM 凭据。

若希望复用根目录 `antarestra.yml`，则把差异写进 `antarestra.local.yml`，直接运行 `pnpm dev` 或 `pnpm start` 即可自动合并。该覆盖文件可以只包含第三方插件；存在时配置面板只向它保存修改。下面的独立最小配置使用另一文件名，避免继承默认配置中的其他服务。

```yaml
plugins:
  logger: {}
  server:
    host: 127.0.0.1
    port: 14451
  database: {}
  database-kysely:
    type: sqlite
    filename: data/antarestra-local.sqlite
  webui: {}
  rbac: {}
  auth-local:
    providerId: local
    allowRegistration: false
    bootstrapEmail: admin
    bootstrapPassword: $ANTARESTRA_ADMIN_PASSWORD
  admin-console: {}
  config-panel: {}
  ai: {}
  ai-agent-core: {}
  ai-provider: {}
  ai-agents: {}
  basic-tools: {}
  wake-tasks: {}
  markdown-render: {}
  chat-webui: {}
```

`bootstrapEmail` 是兼容保留的配置字段名，值现在表示登录名，不要求邮箱格式。输入管理员密码并使用绝对配置路径启动：

```powershell
$adminSecret = Read-Host '设置初始管理员密码（8–128 字符）' -AsSecureString
$env:ANTARESTRA_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecret).Password
$localConfig = (Resolve-Path -LiteralPath './antarestra.dev.local.yml').Path
pnpm start "--conf=$localConfig"
```

访问 `/auth/user/`，用 `admin` 和刚输入的密码登录；在 `/admin/` 的“AI 设置 → 提供商接入”创建连接和模型，再到首页发送消息。`ai-agents` 已提供默认助理。初始化只创建不存在的账号，不会提升已有同名账号的权限。首次创建完成后，从配置中移除两个 `bootstrap` 字段，并在相应终端移除 `ANTARESTRA_ADMIN_PASSWORD` 环境变量。

`pnpm start` 持续运行，Ctrl+C 关闭。它在 `apps/server` 下执行，因此示例数据库位于 `apps/server/data/antarestra-local.sqlite`。插件中的相对文件路径未统一相对于 YAML 目录解析；需要固定位置时使用绝对路径。

健康接口 `/api/health` 仅表示 HTTP 可用。单个插件失败不会让所有服务退出，需在插件设置中检查依赖和实例状态。启动参数、环境变量和实例键规则见[配置加载器](../packages/config-loader/README.md)。

## 使用 PostgreSQL

数据库实现支持 SQLite、PostgreSQL 和 MySQL；选定一种主数据库。根 `antarestra.yml` 配置了 PostgreSQL，并引用多个外部服务的环境变量，不能在未检查配置时视为零配置示例。

本地 PostgreSQL 可独立启动：

```powershell
pnpm startdevdb
```

该命令使用 `compose.dev.yml`，启动 PostgreSQL 18 并等待健康检查，复用已有容器及数据卷。开发库仅绑定 `127.0.0.1:5432`；账号、数据库名及本地开发密码见该 Compose 文件。启动 AI 服务不会自动启动或停止数据库。

在主配置中替换数据库实现的配置，并从环境或同级 `.env` 提供连接串：

```yaml
database-kysely:
  type: postgresql
  url: $ANTARESTRA_DATABASE_URL
```

切换时移除 SQLite 的 `filename`。数据库切换不会迁移已有数据；先做好备份。需要暂停开发库时运行 `docker compose -p antarestra-dev -f compose.dev.yml stop`，保留数据卷。方言、迁移权限与测试要求见[数据库实现](../plugins/implementations/database-kysely/README.md)。

## 按需启用其他能力

| 需求       | 装配与要求                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空间记忆   | 启用 `memory`；主库为 PostgreSQL 时复用，否则另配 `postgresUrl`。[配置说明](../plugins/features/memory/README.md)                                                                                                     |
| 文件与附件 | 启用 `storage`、`storage-s3`、`workspace-file`，配置 S3 兼容后端。开发环境依次运行 `pnpm startdevstorage`、`pnpm initdevstorage`、`pnpm test:storage`。[S3 / RustFS](../plugins/implementations/storage-s3/README.md) |
| 网页工具   | 启用 `http`、`playwright`、`web-tools`，安装可用的系统浏览器；搜索另需 Serper Key，截图持久化需要文件服务。[网页工具](../plugins/features/web-tools/README.md)                                                        |
| 远端终端   | 启用 `http`、`open-terminal`，配置连接 URL 和 API 密钥。四个工具共享同一远端，不按工作空间隔离。[远端终端工具](../plugins/features/open-terminal/README.md)                                                           |
| IM         | 启用 `im`、`identity-im`、`im-commands`、所选适配器与 `im-ai`；管理页面由 `im-console` 提供。[IM 概览](../plugins/definitions/im/README.md)、[飞书接入](飞书机器人接入.md)                                            |
| 源码热更新 | 启用 `hmr`，使用开发入口及对应前端构建监听。[HMR](../plugins/features/hmr/README.md)                                                                                                                                  |

这些能力有独立的外部依赖和安全边界。测试用模型与内存替身不能代替真实提供商、数据库、对象存储或平台账号验证。

## 开发与构建监听

`pnpm dev` 当前只启动服务端 `tsx watch`，**不会先构建，也不会自动启动前端监听**。先执行一次 `pnpm build`，再运行：

```powershell
pnpm dev "--conf=$localConfig"
```

另开终端，为需要修改的界面插件启动监听，例如：

```powershell
pnpm --filter @antarestra/plugin-chat-webui dev
```

修改页面壳时运行 `pnpm --filter @antarestra/webui dev`。HMR 插件更新服务端插件及已构建的前端扩展；`packages` / `apps` 的源码变化由 `tsx watch` 重启进程。页面壳更新需要刷新浏览器，受影响扩展不保留组件本地状态。仓库当前没有根级 `dev:web`、`dev:server` 命令。

## 检查与提交

| 命令                            | 用途                                         |
| ------------------------------- | -------------------------------------------- |
| `pnpm build`                    | 按依赖顺序构建服务端与前端                   |
| `pnpm typecheck`                | 检查项目引用、Vue 与测试类型                 |
| `pnpm test`                     | 执行 Vitest；部分外部集成由环境变量显式启用  |
| `pnpm format:check`             | 检查格式                                     |
| `pnpm format`                   | 格式化整个仓库；局部修改优先只格式化改动文件 |
| `pnpm check`                    | 依次执行格式、类型、测试、构建               |
| `node scripts/smoke-server.mjs` | 在临时端口验证编译后的 Server 并回收子进程   |
| `pnpm create:webui <名称>`      | 从标准模板创建 WebUI 插件                    |

Windows 遇到临时路径或文件监视器问题时，可将 `TEMP` / `TMP` 设为仓库内绝对路径，再使用 `pnpm exec vitest run <测试文件> --maxWorkers=1` 排查。必须区分实际回归与单独复现结果，不把跳过的外部测试算作通过。

依赖变更通过包管理器命令完成，例如 `pnpm --filter @antarestra/webui add 包名`、`pnpm add -Dw 包名`。提交前检查差异、运行相关验证并使用简体中文提交概要；不自动推送。完整约定见 [AGENTS.md](../AGENTS.md)。
