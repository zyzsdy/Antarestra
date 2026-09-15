# 项目开发与协作说明

## 必须遵守

1. 本项目使用 TypeScript + Vue，包管理器统一为 pnpm。安装或调整依赖应通过 `pnpm add`、`pnpm remove` 等命令完成，不采用先修改 `package.json` 的依赖字段再运行 `pnpm install` 的方式。此规则同样适用于其他语言的包管理器。首次安装依赖时可以运行 `pnpm install`。
2. 创建的任何文档内容均使用简体中文，计划、说明与任务输出也使用简体中文。
3. 每次完成一项任务后，都应主动提交 Git，使用简体中文编写提交概要。提交前检查差异并完成与变更相匹配的验证，不自动推送远程仓库。
4. Cordis 使用 **`cordis@4.0.0-rc.10` 精确版本**，允许使用新特性。后续遇到破坏性变更再明确升级和重构，不维护 3.x 兼容层，不擅自切换到 `@cordisjs/core` 或 `@deepseek-ai/cordis`。
5. 当前工作环境是 Windows，默认 shell 为 PowerShell 7（`pwsh`）；Node 由 fnm 管理，应在 pwsh 中运行 Node 与 pnpm。路径可能带空格，命令参数必须正确引用；注意最大命令长度，大型编辑拆成多次。
6. 可以建立 Git 分支，除非用户明确要求，不主动建立工作树。尊重已有文件的缩进与换行，不覆盖任务之外的改动。
7. 插件统一依赖 `@antarestra/plugin-sdk` 并从中导入 Cordis 运行时和类型，只有 SDK 直接依赖 Cordis。服务类型扩展声明在 `@antarestra/plugin-sdk` 模块上。所有 `plugins/` 下插件包必须在 `package.json` 的 `keywords` 数组中包含 `antarestra-plugin`。

## 当前项目结构

```text
Antarestra/
├─ apps/
│  └─ server/                      # 启动入口与主配置路径选择
│     └─ src/plugins.ts            # 提供 server 的模块解析范围
├─ packages/
│  ├─ contracts/                   # 最小跨边界 DTO，不引用 pi 或 Vue
│  ├─ config-loader/               # 核心配置加载与自动包名解析
│  └─ plugin-sdk/                  # Cordis 统一导出与注册表辅助类
├─ plugins/
│  ├─ definitions/
│  │  ├─ database/                 # 数据库服务与插件迁移契约
│  │  └─ webui/                    # WebUI 服务、Vue 页面壳与客户端页面契约
│  ├─ implementations/
│  │  └─ database-kysely/          # 数据库实现
│  └─ adapters/
│     └─ server/                   # HTTP/HTTPS、API 路由、中间件与静态文件
├─ tests/integration/             # Cordis 插件与资源生命周期测试
├─ .github/workflows/             # Windows / Linux 检查流程
├─ pnpm-workspace.yaml            # 工作区范围与明确允许的构建脚本
├─ pnpm-lock.yaml                 # 必须提交的依赖锁文件
├─ antarestra.yml                  # 默认主配置
├─ tsconfig.base.json             # 公共严格类型配置
├─ tsconfig.tests.json            # 测试与 Vitest 配置的类型检查
└─ vitest.config.ts               # 测试入口，使用源码 development 导出
```

`plugins/` 仅放通过主配置发现和加载的外部插件。核心直接依赖的基础设施（如 `config-loader`）放在 `packages/`。工作区预留 `plugins/features/*`，不要为了填目录而批量创建空包。

后续按实际任务增加：

- 定义插件：`agent`、`llm`、`identity`、`workspace`、`conversation`、`storage`、`tools`、`skills`、`mcp`。
- 实现插件：`agent-pi`、`llm-pi`、身份映射、数据库等；pi-agent 与 pi-ai 必须是独立插件。
- 业务插件：`plugins/features/chat` 与 `agent-presets` 等。
- 入口插件：网页 API、嵌入入口与具体 IM 平台适配器。
- 主配置使用根目录 `antarestra.yml`，加载器校验平铺 `plugins` 映射；后续按需要扩展配置管理能力。

## 开发命令

在仓库根目录运行，使用 Node.js 24 与 pnpm 11.7.0。

| 命令                             | 用途                                      |
| -------------------------------- | ----------------------------------------- |
| `pnpm install --frozen-lockfile` | 按锁文件恢复依赖                          |
| `pnpm dev`                       | 构建后运行前端构建监听与服务端 watch      |
| `pnpm dev:web`                   | 仅启动前端静态资源构建监听                |
| `pnpm startdevdb`                | 独立启动 Docker PostgreSQL 开发库         |
| `pnpm dev:server`                | 仅启动服务端 watch                        |
| `pnpm build`                     | 按依赖顺序构建各包与网页                  |
| `pnpm start`                     | 执行编译后的服务并持续监听 HTTP，需先构建 |
| `pnpm typecheck`                 | 检查服务端项目引用、Vue 与测试类型        |
| `pnpm test`                      | 执行插件生命周期测试，不需要模型密钥      |
| `pnpm format`                    | 用 Prettier 格式化仓库                    |
| `pnpm format:check`              | 检查格式，不改写文件                      |
| `pnpm check`                     | 格式、类型、测试、构建的完整检查          |

新增依赖示例：`pnpm --filter @antarestra/webui add 包名`；根级开发工具使用 `pnpm add -Dw 包名`；工作区依赖使用 `pnpm --filter 目标包 add '内部包名@workspace:*'`。

一般选择最新稳定依赖；明确的兼容性限制可锁版本并记录原因。TypeScript 固定为 6.0.3，原因是初始化时 TypeScript 7.0.2 与 vue-tsc 3.3.11 不兼容；根包与网页包需一起升级并验证。`@types/node` 跟随 Node 24。pnpm 的 `allowBuilds` 只显式允许需要的依赖构建脚本，不全局放开。

## 工程约定

- ESM 模块，2 空格、LF、UTF-8、单引号、无分号，以 Prettier 配置为准。
- 默认严格类型检查，启用 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。优先明确契约，不用 `any` 掩盖边界问题。
- 服务端包通过 TypeScript 项目引用生成 `dist` 与声明文件；`typecheck` 中的 `tsc -b` 会更新这些被 Git 忽略的构建产物。
- 模块解析使用 Bundler，以兼容 Cordis 4 当前声明文件中的扩展名省略。服务端自己编写的相对导入仍使用 `.js` 扩展名，确保编译后可直接由 Node 执行。
- 内部包的默认运行导出与类型导出指向 `dist`，`development` 条件指向源码。tsx watch 和 Vitest 使用该条件，开发与测试无需先手动构建。
- 新建服务端工作区包时同步设置清单、导出、构建脚本和项目引用。依赖写入所属包，避免偶然依赖根目录提升的模块。
- 当前 CI 同时检查 Windows 和 Linux；增加 CI 平台声明前，区分本机验证与远端执行结果。

## 插件边界与生命周期

- 定义层只暴露项目自己的契约；消费插件不得直接导入实现插件。启动装配层可以引用具体实现。
- `ctx.plugin()` 返回可等待的 Fiber。需要确认就绪的装配与测试必须等待它；卸载使用 `await fiber.dispose()`。不要复制旧版 `ctx.start()`、`ctx.stop()`、`reusable` 或生命周期事件写法。
- 注册表不等于后端就绪。调用时仍需检查 `backendId`、`connectionId` 等注册项是否存在及是否获得授权。
- 每次能力注册明确传入所属插件上下文，通过 `ctx.effect()` 绑定回收。网络、事件、定时器与子进程也必须回收，异步清理必须可等待。
- 注册标识重复时明确拒绝，不静默覆盖。回收必须幂等，旧实例的回收函数不能删除后来注册的新实例。
- 多实例的配置、凭据、连接与运行状态各自独立。模块顶层不能存放跨用户共享的可变 Agent 或账号状态。
- 基础生命周期机制不等于热重载平台或安全沙箱；文档与界面不能把规划能力描述为已实现。

## 多用户与真实 AI 接入约定

- Actor、Workspace 与 Conversation 分开建模。空间必须由服务端解析与校验，所有数据和能力访问携带空间范围。
- 入口不直接调用 pi。聊天业务依赖 Agent 定义，Agent 实现依赖 LLM 定义，LLM 实现适配 pi-ai。
- 预设包含系统提示词、工具、Skill、MCP Server 和模型连接选择，运行时应固定版本快照。
- 有状态 Agent 按会话或运行创建；同会话默认串行，不同会话允许并发。IM 回调要处理重复投递。
- 密钥、令牌和真实账号配置不写进仓库、日志或网页；未来通过服务端凭据引用读取。
- 工具执行、Skill 资源和 MCP 连接分别鉴权。Cordis 上下文不提供不可信插件的进程安全隔离。

## 验证与提交

初始化的完整检查为 `pnpm check`，另用 `pnpm start` 验证编译产物。后续变更运行相关检查；插件生命周期改动应覆盖独立卸载、依赖变化和资源清理，租户功能改动应覆盖跨空间拒绝访问。

默认启用 `plugin-server`，健康接口为 `/api/health`，默认监听 `0.0.0.0:14451`。CI 使用 `node scripts/smoke-server.mjs` 验证编译产物并回收子进程，避免持续监听阻塞流水线。Server 消费插件使用 `inject: ['server']`，通过带所属上下文的 `use`、`route`、`static` 注册能力；API 路径由 server 统一添加 `/api`。

用户权限基础位于 `plugins/definitions/rbac`，本地认证位于 `plugins/implementations/auth-local`。需要授权的业务插件同时注入 `rbac` 和 `server`，声明权限后通过 `ctx.rbac.require()` 检查；空间范围必须由服务端解析，`system` 不覆盖工作空间。local 页面通过 WebUI 客户端扩展注册，默认位于 `/auth/user/`，管理员仅通过环境变量显式初始化。多个插件联合写入使用 `ctx.database.transaction()`，每个插件在事务中通过自己的服务操作自己的命名空间。数据库切换和本地开发库说明见根 README。

网页布局修改需在浏览器检查实际页面，至少关注常规窗口和窄屏布局。不要把演示后端测试称为真实模型集成测试，也不要把内存验证称为数据库验证。

完成任务后查看 `git diff` 与 `git status`，选择性暂存并提交，例如：`git commit -m '初始化插件式云端智能体项目'`。若 Git 身份等外部条件阻塞提交，明确说明，不擅自伪造身份。除非用户要求，不推送、不改写历史。

新增 WebUI 插件必须执行 `pnpm create:webui <名称>` 从 `templates/webui-plugin/` 起步，保留 `@antarestra/webui/vite` 统一构建入口。界面使用 Vue SFC，禁止用 `h()` 堆叠整页或用 JavaScript 字符串维护 CSS；少量注册适配代码可使用 `h()`。详见 `plugins/definitions/webui/README.md`。
