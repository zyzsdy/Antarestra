# AI 对话核心

`@antarestra/ai` 提供 `ctx.ai`，依赖 database、rbac 和 server。核心不导入 pi；模型驱动和执行后端由其他插件注册。默认主配置启用 `ai: {}` 和执行后端 [ai-agent-core](../../implementations/ai-agent-core/README.md)。仍需注册 Agent 并配置可用模型才能进行模型调用。

## 注册和执行

消费者声明 `inject: ['ai']`，所有注册方法首先传入消费者自己的 `ctx`，返回可等待的回收函数，也随插件卸载自动回收。

| 方法                                | 能力                                              |
| ----------------------------------- | ------------------------------------------------- |
| `registerAgent(ctx, agent)`         | 版本化助理配置，声明模型、工具、Skill、扩展和模板 |
| `registerProvider(ctx, provider)`   | 独立连接实例、模型目录、协议驱动和凭据解析器      |
| `registerDriver(ctx, driver)`       | 模型请求、流式增量和可选上下文估算                |
| `registerBackend(ctx, backend)`     | 使用受控运行接口执行模型—工具循环                 |
| `registerTool(ctx, tool)`           | 参数 Schema、描述、执行函数和超时                 |
| `registerSkills(ctx, service)`      | 唯一 Skill 服务，按当次选择构造 `use_skill`       |
| `registerExtension(ctx, extension)` | 扩展配置 Schema 和准备逻辑                        |
| `registerResources(ctx, resolver)`  | 验证图片及文件引用的空间访问权限                  |

Agent 的 `models` 是 `{ providerId, modelId }` 列表，`defaultModel` 必须在其中。Provider 的 ID 是连接实例 ID，不是厂商名称；同厂商不同账号应分别注册。凭据通过 `resolveCredential(context)` 获取，仅传给驱动，不持久化、不通过 HTTP 输出。

工具同名注册按栈覆盖，卸载栈顶后恢复上一有效实现；卸载非栈顶不会影响当前实现。Run 固定开始时的实现，覆盖不会改变正在运行的工具；卸载其绑定实现将取消 Run。其他能力拒绝重复 ID。`use_skill` 只能由唯一 Skill 服务提供。

`skillIds: null` 表示全部，`[]` 禁用，其余为显式选择；Skill 服务负责目录描述和执行范围校验。核心不假设 Skill 的存储方式。

模板使用 `{{input}}` 和 `{{变量名}}`；普通变量来自输入的 `variables`。插件可通过 `registerTemplateVariable(ctx, { id, description, resolve })` 注册服务端变量，`description` 用于说明变量含义。`listTemplateVariables()` 返回内置 `input` 与当前已注册变量的名称和说明，不调用解析函数或暴露变量内容。变量在系统模板、用户模板与原始输入中按需解析一次；输入变量不能覆盖注册名称。`input` 为展开服务端变量后的用户文本，插入的变量内容不递归解析。缺失模板变量报错，不执行表达式。Run 保存原始输入、渲染后的用户消息和每次模型请求最终快照。

`authorizeRunContext(context, toolOnly)` 验证核心签发的活动运行或工具上下文，并重新核对授权；`checkRunConversation(context, id)` 验证工具引用的会话属于当前空间。`generateMemory(context, text, maxTokens, prompt)` 通过当前运行模型执行无工具的辅助文本整理，复用调用次数上限、窗口分段、取消和无活动超时；请求用途为 `memory`，并保存返回用量。记忆插件仍负责固定分词器预算校验与数据库提交。

## 最小执行后端

以下是适配接口示例，不包含真实模型实现。实际插件需要单独注册模型驱动和连接。

```typescript
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/ai'

export const inject = ['ai']

export function apply(ctx: Context) {
  ctx.ai.registerBackend(ctx, {
    id: 'example-loop',
    async run(runtime) {
      for (;;) {
        const reply = await runtime.request()
        const calls = reply.content.filter((block) => block.type === 'tool-call')
        if (!calls.length) return
        await runtime.executeTools(calls)
      }
    },
  })
}
```

`runtime.request()` 负责执行转换钩子、检查能力、保存请求、调用驱动和记录结果；`executeTools()` 必须传入刚返回的完整调用批次。驱动在 `generate()` 中通过 `await update({ type: 'delta', kind: 'text', text })` 上报增量，通过 `{ type: 'activity' }` 表示心跳；最终返回完整内容。驱动须正确映射提供商的超限错误为 `AiError('context_overflow', ...)`，并遵守 `context.signal`。

工具默认并行，同一工具可同时执行。副作用工具必须自行控制外部资源并发；取消不撤销已发生的操作。不支持不可信插件进程隔离。

## Cordis 扩展事件

事件类型扩展位于 SDK，直接使用 Cordis 原生方法订阅：

```typescript
ctx.on('ai/request', (context, draft) => {
  if (context.agent.extensions['prompt-extra']) {
    draft.systemPrompt += '\n请简要说明推理依据。'
    draft.thinking = 'high'
  }
})

ctx.on('ai/event', async (event, agent) => {
  if (event.type === 'run-end') {
    // 读取已持久化终态，或更新插件自己的状态。
  }
})
```

| 事件             | 草稿/用途                                    |
| ---------------- | -------------------------------------------- |
| `ai/prepare`     | Run 准备阶段                                 |
| `ai/template`    | 本轮 system/user 模板渲染结果                |
| `ai/request`     | 每次模型请求前的模型、思考强度、参数和提示词 |
| `ai/context`     | 每次请求前的上下文处理，可裁剪或注入内容     |
| `ai/tool-before` | 调用前校验；设置 `blocked` 可拒绝执行        |
| `ai/tool-after`  | 工具结果处理，修改 `result` 与 `isError`     |
| `ai/event`       | 已持久化的运行、请求、消息、工具及终态事件   |

转换通过 `ctx.serial()` 分发，按 Cordis 注册顺序和 `prepend` 执行；监听器修改草稿并返回 `void`，不要返回结果对象触发串行提前结束。转换异常导致运行失败。通知通过 `ctx.parallel()` 分发，失败仅记录通用日志，不改变已提交结果；通知不阻塞运行及数据库队列，不保证异步通知处理完成顺序，消费者按事件序号处理。事件不携带凭据，通知负载冻结。

## 会话和授权

先调用 `await ctx.ai.authorize(source, request)`，通过 RBAC 认证来源得到不可伪造的进程内访问句柄；其他方法传入该句柄。每次操作重新校验认证与空间。句柄不能从浏览器 JSON 重建。

`ai.chat.use` 默认授予 user/admin；注册能力对拥有权限的用户开放，历史按空间隔离。当前身份实现只提供个人空间，共享空间成员管理不在本插件实现范围。

`createConversation(access, agentId, title?)` 创建会话；`getConversation()` 返回会话、全部节点和选中路径；`listConversations()` 支持 offset/limit。`start(access, conversationId, command)` 接收：

```json
{
  "operation": "send",
  "expectedRevision": 0,
  "expectedNodeId": null,
  "idempotencyKey": "调用方生成的唯一请求标识",
  "input": { "text": "你好", "variables": {} }
}
```

`edit` 增加 `targetNodeId` 指向用户消息，`regenerate` 指向用户或助理消息；重新生成使用对应用户的原始输入，忽略附带 input。`model` 和 `thinking` 可逐轮选择。会话固定 Agent ID，下一轮解析最新注册版本，旧 Run 快照不变。

`select(access, id, expectedRevision, expectedNodeId, nodeId)` 保存选中版本；`null` 返回会话起点。发送、切换和编辑使用修订校验。运行中不允许切换或第二次发送；不同会话并行。重复幂等键和相同参数返回原 Run，不同参数冲突。

用户编辑和助理重新生成均追加分支。重新生成重跑整轮，工具可能再次执行；未完成分支必须重试或切换到此前完整节点。内部工具记录保存在 Run 和事件中，节点提供展示内容及版本序号/总数。

## HTTP 与 SSE

接口前缀 `/api/ai`，采用已有 web 认证。写请求要求同源 JSON。

| 方法及路径                             | 用途                                          |
| -------------------------------------- | --------------------------------------------- |
| `GET /catalog`                         | 能力目录                                      |
| `POST /conversations`                  | 创建会话，返回 201                            |
| `GET /conversations?offset=0&limit=50` | 会话列表，limit 最大 100                      |
| `GET /conversations/:id`               | 会话和分支                                    |
| `PATCH /conversations/:id/selection`   | 提交 expectedRevision、expectedNodeId、nodeId |
| `POST /conversations/:id/runs`         | 提交运行命令，返回 202                        |
| `GET /runs/:id`                        | Run 状态、历史及请求快照                      |
| `POST /runs/:id/cancel`                | 提交空 JSON 对象，幂等取消                    |
| `GET /runs/:id/events`                 | SSE，可传 Last-Event-ID 或 after 查询参数     |

SSE 的 `id` 为 Run 内递增序号，`event` 为事件类型，`data` 为完整事件 DTO。先落库再发布，250 毫秒轮询持久游标并分页读取；重连按 ID 去重。断线不取消运行，慢客户端由流背压限制内存。终态事件发送后关闭连接，历史事件不自动清理。

核心路由错误返回 `{ error: { code, message } }`；现有全局认证中间件在路由前拒绝请求时仍使用其原有错误格式。跨空间资源视为不存在。

## 限制与验证

默认 `maxModelCalls: 64`、`modelIdleTimeoutMs: 600000`、`toolTimeoutMs: 600000`。不设 Run 总时限；模型活动重置无活动计时，Provider 可用 `idleTimeoutMs` 覆盖。工具 `timeoutMs` 可覆盖为更长时间，`null` 表示不超时。

默认不裁剪或摘要上下文。驱动可提供 token 估算，不支持估算时由真实提供商反馈超限；上下文事件可实现其他策略。图片/文件仅定义引用契约，需资源解析器和对应模型能力。

单进程运行；重启将遗留运行标记为 interrupted，不重放工具。取消、失败保留已落库的增量和工具事件。数据库故障导致终态无法提交时保留忙碌状态，重启恢复，不假装提交成功。

测试使用假模型驱动与真实 SQLite，覆盖分支、生命周期、并行、超时、Cordis 事件和 HTTP/SSE；不代表真实模型兼容性或 PostgreSQL/MySQL 已验证。

## 历史管理

会话 DTO 增加 `lastActivityAt` 与 `archivedAt`；迁移 `002_conversation_history` 为排序与归档建立列和索引，启动时先幂等回填旧记录，再恢复中断运行。回填活动时间取创建时间及已有运行开始、结束时间的最大值。

`GET /conversations?archived=false&offset=0&limit=50` 默认只返回未归档记录；`archived=true` 返回归档列表，仍是数组响应。数据库按活动时间、ID 倒序排列后分页。运行开始和结束更新活动时间，查看、重命名与归档不改变排序。

`PATCH /conversations/:id` 接收 `{ title?: string, archived?: boolean }`，至少提供一项，返回更新后的会话。标题去除首尾空白后须为 1–200 字符。运行中可改名，不能归档；归档后须恢复才能启动新运行。所有操作复用空间授权与串行写入队列，元数据修改不改变消息修订号。

`RunCommand.thinking` 支持显式 `null`，表示本轮不使用推理强度；省略仍继承 Agent 默认值，防止切换到无推理档位的模型时意外携带旧默认值。

模型驱动保存文本/思考内容中的不透明 `continuation`（连接、模型、驱动与签名），仅在同一目标上回传。它用于提供商的多轮思考续接，不是网页正文，也不包含连接凭据；旧记录中已经丢失的签名不能凭空恢复。

## 上下文预算、裁剪与压缩

每个 Agent 可配置 `contextPolicy`；缺失时使用默认值：自动压缩开启，输出预留 `16000`、近期原文窗口 `10000`，裁剪关闭、指定保留 `3` 轮并保留首条用户消息。运行开始固定配置快照，之后编辑助理不改变当前运行。

`compaction.reserve` 与 `compaction.keepRecent` 接受正整数 token 数或百分比字符串（如 `"10%"`），百分比按本次主请求模型窗口向下取整。输出预留只参与上下文预算，不改变主模型实际最大输出。小窗口模型需要相应调小预留及近期窗口，配置不兼容时明确报错。

每次主模型请求（包括工具返回后的续接）都先组装请求、计算预算，再裁剪，再按需压缩，最后校验工具配对及输入模态。系统提示词、工具声明、有效历史、摘要、输入和附件均计入预算。驱动可实现 `estimateTokens`，否则按 UTF-8 字节与附件成本保守估算；这不是精确分词。模型返回后优先记录含缓存 token 的用量，没有有效用量则回退估算。返回后不自动发起后台压缩。

指定 N 轮表示最近 N 轮完整历史加本轮所有消息；自动模式只在超预算时逐个移除最早完整轮次。工具调用和结果属于同一轮。保留首条用户消息时，将其原始内容块（含附件）合并到裁剪后第一条用户输入，避免重复。所有操作只改变发送给模型的上下文，原始消息、工具结果与分支均保留。

压缩使用内置独立提示词，不携带业务工具；`compaction.model` 可独立选择聊天模型列表之外的已配置模型，仅授权压缩用途。模型留空跟随本次主请求；思考强度留空继承，`off` 表示不指定强度。压缩模型不支持继承强度时拒绝请求，管理员可以显式调整。

近期窗口按消息边界保留，并向前扩展到完整工具调用组的安全边界；当前用户输入和保留的首条输入不会被压缩。更早资料按压缩模型窗口分批汇总，先前摘要与新增历史一起生成新摘要，分批请求计入 `maxModelCalls`。空摘要、输出截断、调用上限、取消和超时不提交摘要；保留的原文本身过大或最终摘要仍超预算时明确失败，不静默缩小保留窗口。

数据库迁移 `003_context_summaries` 增加 AI 命名空间的摘要表。摘要带空间、会话、分支来源、覆盖消息标识及内容指纹、保留边界、模型与用量；与操作完成事件事务提交。恢复对话直接复用适用摘要；编辑、重新生成和裁剪造成来源范围不一致时不误用旧摘要。主模型后续失败不撤销已提交摘要，相同来源重试可以复用；删除会话同时删除摘要。旧消息采用运行 ID 和消息位置生成确定性兼容标识。

运行新增 `contextBudgets`、`contextOperations`；SSE 新增 `context-budget`、`context-operation`。预算携带模型、窗口、已用、剩余、输出预留、可输入额度与估算来源；操作按 ID 更新并携带助理内容中的插入位置。`RequestSnapshot.purpose` 区分 `reply` / `compaction`；`maxOutputTokens` 仅用于独立摘要请求。驱动应返回 `stopReason`，摘要只接受完整结束的结果。

浏览器界面始终显示原始内容。模型按钮左侧的环形提示仅在发送前后更新，Tooltip 显示预算来源；切换模型后旧快照标记“上次请求”，未发送草稿不计入。裁剪和压缩分割线位于“已处理”内，数字为完整有效上下文的估算值，不含输出预留；摘要内容不进入聊天正文和复制结果。

验证组件可运行 `pnpm exec vite --config tests/fixtures/markdown-preview.config.ts --host 127.0.0.1 --port 0`，打开输出端口的 `/tests/fixtures/context-preview.html`。该页面仅使用模拟数据，不调用真实模型。
