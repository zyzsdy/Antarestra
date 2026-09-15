# Antarestra

Antarestra 是一个面向多用户、多 Agent 的 Cloud AI Harness。目标是让同一套智能体能力既能通过网页登录使用，也能嵌入其他网站，或进入工作 IM 的群组与话题。

项目以 **Cordis 为插件运行时、TypeScript 为开发语言、Vue 为网页技术栈、pnpm workspace 为工程基础**。一切业务能力都通过插件提供，Agent 运行核心与 LLM 接入也不例外。

## 当前阶段

本仓库完成的是项目初始化，还不是可部署的云端聊天产品。

- 已实现：工作区与构建配置、Cordis 启动器、YAML 配置加载插件、统一插件 SDK、带生命周期归属的注册表、HTTP/HTTPS Server 插件、数据库服务与声明式插件迁移、Vue 页面壳与插件生命周期测试。
- 已实现用户基础能力：可插拔认证实例、主体与会话、RBAC 权限、local 注册登录与管理页面，使用 database 插件持久保存。
- 尚未实现：真实 pi-agent / pi-ai 适配、预设管理、聊天业务数据持久化、聊天 API / SSE、网站嵌入、IM、工具执行、Skill 加载、MCP 和运行沙箱。
- 网页通过 WebUI 插件加载页面，账号中心已连接认证与权限 API。

## 快速开始

环境要求：Node.js 24、pnpm 11。仓库通过 `packageManager` 固定 pnpm 11.7.0，并提交锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

网页与 API 共用 Server，首页位于 <http://localhost:14451/>。`pnpm dev` 先构建静态资源，再启动服务端与前端构建监听。服务端启动后持续监听 HTTP，健康接口为 <http://127.0.0.1:14451/api/health>。开发时插件源码修改由 [HMR 插件](plugins/features/hmr/README.md) 在原进程中热替换，`packages` / `apps` 源码修改由 `tsx watch` 重启服务。前端文件修改后自动重新构建，刷新浏览器查看；后端扩展注册变化通过 HMR WebSocket 同步。

也可以分别运行：

```powershell
pnpm build
pnpm dev:web
# 在另一终端运行
pnpm dev:server
```

执行检查与构建后，验证编译产物：

```powershell
pnpm check
pnpm start
```

`pnpm start` 启动服务并持续监听 HTTP；按 Ctrl+C 关闭。

CI 使用 `node scripts/smoke-server.mjs` 在临时端口启动编译产物，验证健康接口并关闭子进程；本机也可以运行该命令。

## WebUI 页面插件

`webui` 定义插件提供抽象 Vue 框架和扩展注册能力。后端使用 `ctx.webui.addEntry()` 注册浏览器入口，客户端通过 `ctx.page()` 注册 Vue 页面及 Vue Router 守卫。WebUI 不提供业务页面或自动导航，公共通知与对话框通过前端 Vue inject 获取。接入方式见 [WebUI 说明](plugins/definitions/webui/README.md)。默认首页由 [chat-webui](plugins/features/chat-webui/README.md) 提供，通过 RBAC 的 `web` 请求通道解析用户与个人工作空间，验证 `useChatWebUI` 权限；访客跳转登录。当前只提供界面预览，不发送消息或存储聊天记录。

## 用户与权限

服务启动后打开 <http://127.0.0.1:14451/auth/user/>，可以注册和登录。公开注册不授予管理员权限，首次管理员通过 [local 插件配置](plugins/implementations/auth-local/README.md) 显式初始化。业务授权接入见 [RBAC 说明](plugins/definitions/rbac/README.md)。

### 独立开发 PostgreSQL

```powershell
pnpm startdevdb
```

命令通过 `compose.dev.yml` 启动 PostgreSQL 18，等待健康后返回。重复执行复用容器和数据卷，不与 `pnpm dev` 联动，也不随开发服务退出。用户名与数据库名均为 `antarestra`，开发密码为 `lp1234xy`，只监听本机 `127.0.0.1:5432`。

默认主配置使用 PostgreSQL，并从 `ANTARESTRA_DATABASE_URL` 读取连接串：

```yaml
plugin-database-kysely:
  type: postgresql
  url: $ANTARESTRA_DATABASE_URL
```

在启动服务的 PowerShell 中设置连接串：

```powershell
$env:ANTARESTRA_DATABASE_URL = 'postgres://antarestra:lp1234xy@127.0.0.1:5432/antarestra'
pnpm dev
```

SQLite 与 PostgreSQL 数据互不迁移。Docker 拉取失败时需恢复到 Docker Hub 的网络连接，不要删除已有数据卷来重试。一般无需关闭开发库，必要时可运行 `docker compose -p antarestra-dev -f compose.dev.yml stop`，保留数据。

## 核心设计

### 主配置与插件加载

复制 `.env.example` 为所选 YAML 同级的 `.env` 并填写凭据；Git 已忽略 `.env`。配置字符串以 `$` 开头时，按 `$ENV_NAME` 读取变量，否则保持原样。变量名仅允许字母、数字、下划线且不能以数字开头。支持嵌套映射和数组的值，不替换键、不做插值或递归展开，结果始终为字符串。非法引用或变量缺失时启动失败，禁用插件不解析变量。

进程环境优先（包括空字符串），未设置时才取同级 `.env` 的值。`.env` 可省略，支持引号、注释及多行值，不会修改进程环境。旧字段 `urlEnv`、`bootstrapPasswordEnv` 分别改为 `url: $ANTARESTRA_DATABASE_URL`、`bootstrapPassword: $ANTARESTRA_ADMIN_PASSWORD`；配置路径不再读取 `ANTARESTRA_CONFIG`，改用 `--conf`。

服务端按以下优先级选择一个 YAML 主配置文件。选中的文件不存在或格式错误时启动失败，不回退到低优先级配置：

1. 命令行参数 `--conf=路径`。
2. 仓库根目录的 `antarestra.yml`，由 server 源文件或编译产物位置计算，与启动工作目录无关。

显式指定的相对路径相对于服务端进程工作目录。`pnpm start` / `pnpm dev:server` 在 `apps/server` 下运行，推荐使用绝对路径，含空格时给整个参数加引号：

```powershell
pnpm start '--conf=E:/Antarestra 配置/antarestra.yml'
pnpm dev:server '--conf=E:/Antarestra 配置/antarestra.yml'
```

配置采用 Koishi 风格的平铺 `plugins` 映射，每个条目保存一份独立实例配置。键名前加 `~` 禁用实例，禁用条目不会解析或导入插件模块：

```yaml
plugins:
  plugin-server: {}
  database: {}
  plugin-database-kysely:
    filename: antarestra.sqlite
  webui: {}
  rbac: {}
  plugin-auth-local:9ce0b8f2:
    providerId: local
    allowRegistration: true
  ~plugin-auth-local:73f1a6d4:
    providerId: secondary
    allowRegistration: false
```

同一插件有多份配置时，每份键名都必须使用 `插件名:随机哈希`，哈希为 8–32 位小写十六进制。哈希在创建配置时生成并保存，重启不重新生成；复制实例时生成新哈希。加载器导出 `createInstanceId(pluginId)`，也可运行 `node -e "console.log(require('node:crypto').randomBytes(4).toString('hex'))"` 生成哈希。单实例可以省略哈希。启用和禁用条目不能重复使用同一个实例标识。哈希不替代 `backendId` 等业务标识，也不会让原本只支持单实例的插件获得多实例能力。

插件包名采用自动解析，无需在 server 维护别名表。配置中的 `example` 按以下顺序查找，使用第一个存在的包：

1. `@antarestra/example`
2. `@antarestra/plugin-example`
3. `antarestra-plugin-example`
4. `example`

任意不带 scope 的名字均遵循此顺序。带 scope 的完整包名（如 `@other/example`）直接精确匹配；以 `@` 开头的 YAML 键必须加引号，如 `'@antarestra/plugin-auth-local:9ce0b8f2'`。通过 `pnpm --filter @antarestra/server add 包名` 安装插件后即可由配置加载。候选包不存在时才尝试下一级；包已找到但入口损坏、内部依赖缺失或执行失败时直接报错，不静默回退。

模块需导出默认函数、类、插件对象或命名的 `apply` 函数。所有插件遵循同一入口协议；`database` 默认导出服务类，不需要加载器特殊处理。

插件按声明顺序加载并等待启动。建议先声明定义，再声明实现，最后声明消费入口；CLI 这类一次性消费者只能看到其启动时已注册的后端。加载结束时检查所有插件是否就绪，缺少启用的服务依赖会报错。启动失败时回收本次创建的插件，退出时等待资源清理。有监听器或定时器的插件会持续运行，默认 CLI 演示完成后自然退出。

当前只支持平铺映射，不支持 Koishi 插件分组、表达式、YAML 别名、配置热重载或在线编辑。加载器校验主配置结构，插件自身负责具体配置字段的语义校验。不要在仓库配置中保存真实凭据。

### 插件 SDK 与包标识

插件统一依赖 `@antarestra/plugin-sdk`，从中导入 `Context`、`Service` 等运行时入口，以及 `Plugin`、`Fiber`、`Inject` 等 Cordis 类型。SDK 直接转导出上游 API，并提供 `ScopedRegistry`；只有 SDK 直接依赖精确版本的 Cordis，不创建另一套上下文或兼容层。服务类型扩展也声明在 SDK 模块上：

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

所有 `plugins/` 下的插件包在 `package.json` 中声明 `"keywords": ["antarestra-plugin"]`，供未来市场识别。使用 npm 标准的复数 `keywords` 字段；市场插件本身尚未实现。

### 极小启动器，三层插件

启动器负责建立上下文、选择主配置路径、提供模块解析范围及处理退出。核心直接依赖的 `config-loader` 放在 `packages/config-loader`，读取 YAML、自动解析包名并装配启用的插件。`plugins/` 中仅放由主配置发现和加载的外部插件；将包列为 server 的依赖仅用于安装与模块解析，不会自动激活它。配置管理界面尚未实现。

| 层次     | 职责                                 | 示例                                          |
| -------- | ------------------------------------ | --------------------------------------------- |
| 定义插件 | 定义服务接口、事件与运行时注册表     | `database` 提供 `ctx.database`                |
| 实现插件 | 适配具体能力并注册实例，承担资源回收 | `plugin-database-kysely`、`plugin-auth-local` |
| 消费插件 | 只依赖定义，组合能力完成业务         | 聊天编排、预设管理、网页与 IM 入口            |

TypeScript 接口不等于运行时服务。多实现能力由定义插件提供真实注册表，具体实现往其中注册；消费者注入注册表后，还需校验选定后端是否可用。单实现服务可由实现插件直接提供，但契约仍放在定义包。

`packages/contracts` 只容纳跨边界的消息、身份上下文和预设 DTO；服务接口属于各自定义插件，避免形成不断膨胀的中心包。

### 数据库插件

数据库默认启用 SQLite，通过 `database` 定义与 `plugin-database-kysely` 实现装配。支持 PostgreSQL 及 MySQL 方言，消费插件通过 `inject: ['database']` 使用类型化查询。配置及运行要求见 [数据库实现说明](plugins/implementations/database-kysely/README.md)，插件 API 与迁移示例见 [数据库定义说明](plugins/definitions/database/README.md)。

### HTTP Server 插件

`plugins/adapters/server` 的包名是 `@antarestra/plugin-server`。主配置使用 `plugin-server`，避免与启动程序包 `@antarestra/server` 混淆。默认配置如下：

```yaml
plugins:
  plugin-server:
    host: 0.0.0.0
    port: 14451
    publicUrl: ''
    https: false
    cert: ''
    key: ''
    passphraseFile: ''
    debug: false
```

`port` 支持 0–65535，0 表示自动分配端口。HTTPS 开启时，`cert`、`key` 必须指向 PEM 证书和私钥文件；加密私钥可通过 `passphraseFile` 读取密码。文件路径相对于进程工作目录（使用 `pnpm start` 时为 `apps/server`），建议使用绝对路径。密码只去掉末尾换行，保留其他空白；关闭 HTTPS 时不读取这些文件。HTTP 与 HTTPS 二选一，不同时开启两个监听端口。证书无效、文件读取失败或端口占用都会使启动失败。

`publicUrl` 是可选的无凭据 HTTP/HTTPS 外网地址，按配置原样保留；为空时不从请求头推断。插件提供只读 `ctx.server.publicUrl` 和 `ctx.server.address`，后者在监听成功后包含实际地址与端口，关闭后为 `undefined`。

消费插件安装 `@antarestra/plugin-server` 工作区依赖并声明 `inject: ['server']`，使用 Koa 的 `ctx/next` 接口：

```typescript
import type { Context } from '@antarestra/plugin-sdk'
import type {} from '@antarestra/plugin-server'

export const inject = ['server']

export function apply(ctx: Context): void {
  ctx.server.use(ctx, async (http, next) => {
    http.set('X-Example', 'enabled')
    await next()
  })

  ctx.server.route(ctx, 'GET', '/users/:id', (http) => {
    http.body = { id: http.params.id }
  })

  ctx.server.static(ctx, '/assets', '/absolute/path/to/public')
}
```

包导出 `HttpServer`、`Config`、`HttpContext`、`Middleware`、`ApiHandler` 和 `Dispose`。三个注册方法均要求显式传入所属 Cordis 上下文，返回可等待、幂等的撤销函数，也随所属插件卸载自动回收。`route` 支持多个处理函数，自动加 `/api` 前缀，因此示例地址为 `/api/users/:id`；重复填写 `/api`、重复的方法与路径，以及覆盖 `/health` 都会被拒绝。路径匹配区分大小写，末尾斜杠等价，重叠路由按注册顺序匹配。GET 自动支持 HEAD，OPTIONS 返回允许的方法，已知路径的方法不匹配返回 405。

处理顺序为最外层错误捕获、按注册顺序执行的洋葱中间件、API 路由或静态文件、404。`/api` 及其下级路径不会回落到静态文件。静态挂载仅支持 GET/HEAD，可挂载 `/`，嵌套目录按最长前缀优先；文件不存在时继续尝试下一个匹配挂载。支持目录的 `index.html`，不支持目录列表或 SPA 回退，禁止点文件、路径越界及链接到根目录外的文件。注册变化只影响后续请求，已经进入处理链的请求继续使用原快照。

内置 `GET /api/health` 只返回 `{ "status": "ok", "time": "UTC ISO 8601 时间" }`。插件不默认添加请求体解析、CORS、鉴权或网页挂载；中间件可短路请求，因此消费插件需要自行保证自己的中间件策略符合预期。

中间件和 API 抛出的异常统一返回 500，包括 `http.throw(401)` 这样的异常；需要返回正常业务状态时直接设置 `http.status` 和 `http.body`。默认错误正文为 `{ "error": "Internal Server Error" }`；`debug: true` 时返回包含消息、堆栈和原因链的中文 HTML 页面，动态内容全部转义，页面没有脚本、外部资源或模板依赖。错误响应禁止缓存并移除旧响应头，不额外展示请求头、请求体或配置。错误信息本身由抛错插件负责避免包含凭据。

响应头已经发出时无法改写为 500，此时终止连接。Node 可读流及 Web ReadableStream/Blob 的传输错误同样由最外层处理；脱离请求链的后台任务异常不属于这一捕获范围。关闭服务时先停止接收连接，最多等待五秒，随后关闭残余连接。消费插件仍需自行清理后台任务与业务资源。同一上下文只提供一份 `server` 服务；不同上下文实例互相独立，不构成热重载平台或安全沙箱。

### 可逆性与多实例

每次插件激活都有独立的 Cordis Fiber。能力注册、订阅、定时器、网络连接和进程都必须归属该实例，并提供回收逻辑。卸载一个实例只应影响它的能力及其依赖方。

本项目采用 **上游 `cordis@4.0.0-rc.10`，精确锁定版本**。按 4.x 使用可等待的 `ctx.plugin()`、`ctx.effect()`、服务注入与 `fiber.dispose()`；不添加 3.x 兼容层，也不混用 DeepSeek Harness 的 vendored 包。允许采用 4.x 新特性，后续出现破坏性变更时再明确升级并重构。

当前测试验证双实例独立卸载、重复加载无注册残留、服务撤销后的依赖清理与恢复、重复标识拒绝；通用生命周期测试使用测试专用服务。尚不具备运行时管理 API、配置热重载或第三方插件沙箱。

必须区分以下标识：

| 标识           | 含义                                                   |
| -------------- | ------------------------------------------------------ |
| `pluginId`     | 插件包的身份                                           |
| `instanceId`   | 持久化的插件实例键名，包含可选的随机哈希，由加载器管理 |
| `backendId`    | Agent 后端注册项                                       |
| `connectionId` | 某个模型连接，关联独立的账号和配置                     |
| `provider`     | 模型提供方                                             |

同一个模型厂商的两个账号使用两个连接实例，不通过覆盖 `ctx.llm` 切换账号。各实例独立管理凭据、刷新锁、连接状态和在途请求。Cordis Fiber 的运行时编号不能代替持久化的 `instanceId`。

### 用户、空间与会话

将实际发起操作的 `Actor`、资源归属的 `Workspace` 和对话记录的 `Conversation` 分开。

- 网页用户登录后进入个人空间或已加入的共享空间。
- IM 群组映射到共享空间，实际发言成员仍是独立 Actor；话题可映射到不同会话。
- 嵌入入口使用面向指定站点和空间的短期授权，不能把模型凭据交给浏览器。

所有入口最终产生 `actorId + workspaceId + conversationId + channelInstanceId`。这些值必须由服务端身份解析和成员关系校验产生，不能信任客户端传入的空间标识。数据库访问、模型连接选择、工具、Skill、MCP 与附件都须经过空间授权。

共享 Cordis Context 表示能力可以组合，不代表用户数据天然隔离。生产实现必须在数据查询和执行入口强制检查空间范围。插件进程本身属于受信任计算边界；不可信代码和危险工具需要独立 Worker、进程或容器隔离。

### Agent 预设与运行

一个 Agent 预设由系统提示词、一组工具、Skill、MCP Server 以及后端和模型连接选择组成。`AgentPreset` 已提供初始 DTO；当前没有配置编辑器或预设执行逻辑。

计划中的预设结构：

```typescript
const preset = {
  id: 'team-assistant',
  name: '团队助手',
  systemPrompt: '你是团队助手，请使用简体中文回答。',
  backendId: 'pi',
  connectionId: 'team-primary',
  modelId: '由已授权连接的模型目录选择',
  toolIds: ['knowledge-search'],
  skillIds: ['team-writing'],
  mcpServerIds: ['team-docs'],
}
```

每次运行固定一份预设版本与授权后的能力快照。修改预设不应隐式改变进行中的运行。Agent 的有状态对象按会话或运行创建，不在不同用户之间共享。

- `agent-pi` 封装 `@mariozechner/pi-agent-core`，负责 Agent 循环、消息与工具转换、流式事件和取消。
- `llm-pi` 封装 `@mariozechner/pi-ai`，负责模型目录、模型请求与连接凭据适配。模型发现能力以所选 provider 的实际 API 为准。
- `agent-pi` 通过 LLM 定义层使用连接，不依赖 `llm-pi` 实现包。接入前需验证 pi 提供的流式调用扩展点，避免在两层各建一套模型请求实现。
- 工具提供结构化输入与执行能力；Skill 提供版本化指令和资源；MCP 插件负责协议连接与远端工具映射。Skill 文本不能绕过工具授权。

Agent 定义与真实适配将在后续实现，需要明确预设快照、工具调用、用量、错误及持久化协议，不把 pi 的具体类型泄漏进公共契约。

### 云端运行方向

先采用模块化单进程，保留将运行任务移到独立 Worker 的边界，暂不引入微服务。聊天消费插件协调鉴权、会话加载、运行和结果保存；传输插件只处理协议转换。

同一会话默认串行，不同会话可并行。IM 消息使用平台消息标识去重，任务具有明确的运行标识与终态。流式事件后续通过 SSE 输出，记录事件序号以支持重连；取消、超时和插件卸载要终止相应在途请求。

存储由插件提供。开发阶段可从 SQLite 开始，部署阶段按并发与可靠性需求选用 PostgreSQL 等数据库；最终选型尚未确定。凭据通过服务端引用访问，日志不得包含密钥或完整敏感内容。

## 开发路线

1. **初始化（当前）**：工程配置、定义/实现/消费三层示例、双实例生命周期验证、Vue 页面壳。
2. **最小真实聊天闭环**：LLM 定义、pi-ai 和 pi-agent 独立插件、预设解析、内存会话、CLI 多轮流式输出与取消、一个简单工具。
3. **多用户与持久化**：身份、空间、成员权限、持久化会话、运行队列与幂等；验证跨空间访问被拒绝。
4. **产品入口**：网页登录与 SSE、嵌入授权、首个工作 IM 适配，验证群空间与个人身份映射。
5. **扩展能力**：Skill、MCP、双账号连接、插件配置管理、运行隔离、审计与配额。

首个可用版本应能让两个空间分别选择 Agent 和模型连接，完成持久化多轮聊天、流式输出与工具调用，并独立停用一个连接而不影响另一空间。

## 日志输出

默认启用 `plugin-logger`，为 Cordis 原生日志提供终端输出。其他插件直接使用 SDK 中的 `ctx.logger`，不依赖输出器实现。可独立配置终端与文件等级，启用按天或按大小轮转的文件输出；扩展色终端优先使用内置的柔和调色板。配置和生命周期说明见 [日志输出器](plugins/implementations/logger/README.md)。

## 依赖与参考

除明确固定的兼容性版本外，添加依赖时使用 `pnpm add` 查询和安装当前稳定版。TypeScript 当前固定为 6.0.3：初始化时验证发现 TypeScript 7.0.2 与 vue-tsc 3.3.11 的编译器入口不兼容。根目录与网页包保持同一 TypeScript 版本。

- [Cordis 上游仓库](https://github.com/cordiverse/cordis)：插件运行时与生命周期 API。
- [Koishi：可逆的插件系统](https://koishi.chat/zh-CN/cookbook/design/disposable.html)：副作用归属、可回收性与依赖生命周期。
- [DeepSeek Harness：Cordis 教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)：将工具、LLM 与 Agent 循环拆分为插件的思路。其包名与示例需对照当前 Cordis 版本后采用。

项目结构、命令和协作约定见 [AGENTS.md](./AGENTS.md)。
