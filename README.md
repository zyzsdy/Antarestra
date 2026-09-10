# Antarestra

Antarestra 是一个面向多用户、多 Agent 的 Cloud AI Harness。目标是让同一套智能体能力既能通过网页登录使用，也能嵌入其他网站，或进入工作 IM 的群组与话题。

项目以 **Cordis 为插件运行时、TypeScript 为开发语言、Vue 为网页技术栈、pnpm workspace 为工程基础**。一切业务能力都通过插件提供，Agent 运行核心与 LLM 接入也不例外。

## 当前阶段

本仓库完成的是项目初始化，还不是可部署的云端聊天产品。

- 已实现：工作区与构建配置、Cordis 启动器、YAML 配置加载插件、统一插件 SDK、Agent 定义插件、带生命周期归属的注册表、两个演示后端实例、一次性 CLI 冒烟消费者、Vue 页面壳与插件生命周期测试。
- 尚未实现：真实 pi-agent / pi-ai 适配、预设管理、登录与权限、持久化、HTTP / SSE、网站嵌入、IM、工具执行、Skill 加载、MCP 和运行沙箱。
- `agent-demo` 只回显输入，不调用模型，也不模拟真实认证或租户隔离。网页展示项目方向，尚未连接后端。

## 快速开始

环境要求：Node.js 24、pnpm 11。仓库通过 `packageManager` 固定 pnpm 11.7.0，并提交锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

网页默认位于 <http://127.0.0.1:5173>，端口占用时以 Vite 输出为准。服务端在 watch 模式下执行一次双实例演示，源码变化后重新运行，不提供 HTTP 接口。

也可以分别运行：

```powershell
pnpm dev:web
pnpm dev:server
```

执行检查与构建后，验证编译产物：

```powershell
pnpm check
pnpm start
```

`pnpm start` 输出以下内容并正常退出，不需要 API 密钥：

```text
[demo-a] 演示实例甲：插件骨架已就绪
[demo-b] 演示实例乙：插件骨架已就绪
```

## 核心设计

### 主配置与插件加载

服务端按以下优先级选择一个 YAML 主配置文件。选中的文件不存在或格式错误时启动失败，不回退到低优先级配置：

1. 命令行参数 `--conf=路径`。
2. 环境变量 `ANTARESTRA_CONFIG`。
3. 仓库根目录的 `antarestra.yml`，由 server 源文件或编译产物位置计算，与启动工作目录无关。

显式指定的相对路径相对于服务端进程工作目录。`pnpm start` / `pnpm dev:server` 在 `apps/server` 下运行，推荐使用绝对路径，含空格时给整个参数加引号：

```powershell
pnpm start '--conf=E:/Antarestra 配置/antarestra.yml'
pnpm dev:server '--conf=E:/Antarestra 配置/antarestra.yml'
$env:ANTARESTRA_CONFIG = 'E:/Antarestra 配置/antarestra.yml'
pnpm start
```

配置采用 Koishi 风格的平铺 `plugins` 映射，每个条目保存一份独立实例配置。键名前加 `~` 禁用实例，禁用条目不会解析或导入插件模块：

```yaml
plugins:
  agent: {}
  agent-demo:9ce0b8f2:
    backendId: demo-a
    prefix: 演示实例甲：
  agent-demo:73f1a6d4:
    backendId: demo-b
    prefix: 演示实例乙：
  ~agent-demo:d4f706a9:
    backendId: demo-disabled
    prefix: 已禁用实例：
  adapter-cli: {}
```

同一插件有多份配置时，每份键名都必须使用 `插件名:随机哈希`，哈希为 8–32 位小写十六进制。哈希在创建配置时生成并保存，重启不重新生成；复制实例时生成新哈希。加载器导出 `createInstanceId(pluginId)`，也可运行 `node -e "console.log(require('node:crypto').randomBytes(4).toString('hex'))"` 生成哈希。单实例可以省略哈希。启用和禁用条目不能重复使用同一个实例标识。哈希不替代 `backendId` 等业务标识，也不会让原本只支持单实例的插件获得多实例能力。

内置短名 `agent`、`agent-demo`、`adapter-cli` 映射到对应的 `@antarestra/*` 包。其他插件使用完整 npm 包名，通过 `pnpm --filter @antarestra/server add 包名` 安装后加载；以 `@` 开头的 YAML 键必须加引号，如 `'@antarestra/agent-demo:9ce0b8f2'`。模块需导出默认函数、类、插件对象或命名的 `apply` 函数；内置 `agent` 使用其 `AgentRegistry` 类。

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

启动器负责建立上下文、选择主配置路径、提供模块解析及处理退出。独立的 `config-loader` 插件读取 YAML 并装配启用的插件，配置管理界面尚未实现。

| 层次     | 职责                                 | 示例                                      |
| -------- | ------------------------------------ | ----------------------------------------- |
| 定义插件 | 定义服务接口、事件与运行时注册表     | `agent` 提供 `ctx.agents`                 |
| 实现插件 | 适配具体能力并注册实例，承担资源回收 | `agent-pi`、`llm-pi`，当前有 `agent-demo` |
| 消费插件 | 只依赖定义，组合能力完成业务         | 聊天编排、预设管理、网页与 IM 入口        |

TypeScript 接口不等于运行时服务。多实现能力由定义插件提供真实注册表，具体实现往其中注册；消费者注入注册表后，还需校验选定后端是否可用。单实现服务可由实现插件直接提供，但契约仍放在定义包。

`packages/contracts` 只容纳跨边界的消息、身份上下文和预设 DTO；服务接口属于各自定义插件，避免形成不断膨胀的中心包。

### 可逆性与多实例

每次插件激活都有独立的 Cordis Fiber。能力注册、订阅、定时器、网络连接和进程都必须归属该实例，并提供回收逻辑。卸载一个实例只应影响它的能力及其依赖方。

本项目采用 **上游 `cordis@4.0.0-rc.10`，精确锁定版本**。按 4.x 使用可等待的 `ctx.plugin()`、`ctx.effect()`、服务注入与 `fiber.dispose()`；不添加 3.x 兼容层，也不混用 DeepSeek Harness 的 vendored 包。允许采用 4.x 新特性，后续出现破坏性变更时再明确升级并重构。

当前测试验证双实例独立卸载、重复加载无注册残留、服务撤销后的依赖清理与恢复、重复标识拒绝，以及取消请求。尚不具备运行时管理 API、配置热重载或第三方插件沙箱。

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

当前 `AgentRequest` 只是验证生命周期的最小端口。真实适配阶段需要补充预设快照、工具调用、用量、错误及持久化协议，不把 pi 的具体类型泄漏进公共契约。

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

## 依赖与参考

除明确固定的兼容性版本外，添加依赖时使用 `pnpm add` 查询和安装当前稳定版。TypeScript 当前固定为 6.0.3：初始化时验证发现 TypeScript 7.0.2 与 vue-tsc 3.3.11 的编译器入口不兼容。根目录与网页包保持同一 TypeScript 版本。

- [Cordis 上游仓库](https://github.com/cordiverse/cordis)：插件运行时与生命周期 API。
- [Koishi：可逆的插件系统](https://koishi.chat/zh-CN/cookbook/design/disposable.html)：副作用归属、可回收性与依赖生命周期。
- [DeepSeek Harness：Cordis 教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/)：将工具、LLM 与 Agent 循环拆分为插件的思路。其包名与示例需对照当前 Cordis 版本后采用。

项目结构、命令和协作约定见 [AGENTS.md](./AGENTS.md)。
