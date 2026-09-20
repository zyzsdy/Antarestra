# Agents 管理

`@antarestra/plugin-ai-agents` 在管理控制台的“AI 设置 → Agents”提供助理管理，依赖 `ai`、`database`、`rbac`、`server`、`webui`。插件从 `pnpm create:webui ai-agents` 生成，沿用统一 WebUI 构建入口。

## 数据与默认行为

独立数据库命名空间保存 Agent ID、名称、系统与用户提示词模板、执行后端、模型范围与默认模型、工具范围、Skill 范围、默认思考等级、扩展配置及修订号。Agent 为管理员维护的全局预设；会话、历史与能力执行仍由 AI 核心按用户和空间校验，不扩大用户权限。

首次初始化创建固定 ID `default-assistant`、名称“默认助理”，内置通用助理系统提示词。默认助理可以改名和修改全部业务配置，ID 固定、禁止删除；后续初始化不覆盖已保存内容。普通 Agent 同样使用稳定 ID，支持删除。删除会取消该 Agent 的运行，历史保留，但关联会话不能继续运行。

模型、工具和 Skill 列表的 `null` 表示全部（包括之后新注册的能力），`[]` 表示不允许任何项。默认模型为 `null` 时自动选择允许列表中的第一个；显式默认模型必须在指定模型范围内。没有模型时仍可保存配置、创建会话，运行会返回明确的能力不可用错误；AI 目录不列出无法解析模型的 Agent。指定但已卸载的能力不被悄悄替换，运行仍由核心拒绝。Skill 全部模式在没有 Skill 服务时不注入工具，服务接入后自动生效；指定 Skill ID 时由 Skill 服务进一步验证范围。当前 Skill 接口没有目录能力，编辑器支持逐行填写 ID。

每次启动运行解析一次当前能力并生成固定快照；修改 Agent 不影响正在运行的任务。插件卸载回收注册并取消相关运行，重新加载从数据库恢复。

`ctx.ai.createConversation(access)` 或 `POST /api/ai/conversations` 省略 `agentId` 时使用默认助理；显式未知 ID 拒绝请求，不回退。`GET /api/ai/catalog` 返回 `defaultAgentId`。现有聊天首页仍为占位页，本插件不新增聊天发送界面。

## 管理接口

所有管理接口同时校验系统权限 `admin.console.view` 与 `admin.ai.agents.manage`，后者默认赋予 admin。

- `GET /api/ai-agents`：配置列表与默认 Agent ID。
- `GET /api/ai-agents/capabilities`：公开模型、工具、执行后端与 Skill 服务状态，不含凭据。
- `POST /api/ai-agents`：新建，提交完整配置（初始 revision 为 1）。
- `PUT /api/ai-agents/:id`：更新，必须携带读取时的 revision；过期版本返回 409。
- `DELETE /api/ai-agents/:id`：删除，提交 revision；默认助理始终返回 403。

模板延续 AI 核心双花括号变量语法，内置 `input` 为用户输入，其他变量由运行调用方提供。扩展配置为以扩展 ID 为键的 JSON 对象，运行时按扩展 Schema 验证；不使用模板执行 JavaScript。

## 验证

`tests/integration/ai-agents.test.ts` 使用真实 SQLite，覆盖持久化恢复、HTTP 权限、删除保护、冲突校验、动态能力、快照、卸载清理及跨空间拒绝访问。模型驱动为测试实现，不声称真实模型接入验证。
