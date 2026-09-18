# AI 对话核心

`@antarestra/ai` 提供 `ctx.ai`，依赖 database、rbac 和 server。核心不导入 pi；模型驱动和执行后端由其他插件注册。默认主配置启用 `ai: {}`，未注册 Agent 和后端时目录为空，不能进行模型调用。

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

模板使用 `{{input}}` 和 `{{变量名}}`；变量来自输入的 `variables`，`input` 固定为用户原始文本。缺失变量报错，不执行表达式。Run 保存原始输入、渲染后的用户消息和每次模型请求最终快照。

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
