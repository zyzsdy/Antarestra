# 工作空间记忆

`@antarestra/plugin-memory` 提供 `ctx.memory`、`{{global_memory}}` 模板变量和七个模型工具，依赖 `ai` 与 `database`。每个 workspace 独立拥有一份全局记忆和不限数量的长期记忆文档。插件不提供独立管理页面。

## 配置

```yaml
plugins:
  # 在数据库与 AI 服务之后加载。
  memory:
    globalTokenBudget: 4096
    # 主库不是 PostgreSQL 时必填；主库为 PostgreSQL 时复用现有连接池。
    # postgresUrl: $ANTARESTRA_MEMORY_POSTGRES_URL
```

记忆正文、元数据、关联和索引均保存在 PostgreSQL。额外连接由数据库实现管理，随所属插件或数据库后端卸载关闭；连接失败不会回退到内存或其他数据库。切换数据库不会自动迁移记忆。

插件为单实例。同一 workspace 内不同会话、用户和助理共享记忆，模型工具继承 `ai.chat.use` 权限并受助理工具选择约束；模型不能指定 workspace。显式选择工具的助理需要启用以下工具，选择全部工具的助理自动获得它们。

## 全局记忆与模板

在系统提示词、用户消息模板或实际输入中写入 `{{global_memory}}` 即可注入。服务端读取一次并固定为本次运行快照，未创建时注入空文本。模型在本轮修改记忆后，通过工具返回值获取新正文；下一轮重新读取。记忆正文中的双花括号保持原样，不递归展开。输入的 `variables` 不能覆盖服务端注册变量；插件未加载时使用该变量明确报错。原始用户输入与渲染后的模型消息分别保留。

预算只计算正文，固定采用随包发布的 `o200k_base` 分词器，不随模型变化、不运行时下载词表，也不等同于不同模型的实际输入 Token 数。候选内容超预算时，当前模型在无业务工具的辅助请求中合并重复、保留重要事实与偏好并遗忘低价值内容；长输入分段整理。每次写入最多执行三轮整理，所有辅助调用计入运行调用上限，遵循取消和模型无活动超时。结果重新计数，合格后才事务提交。

整理失败或修订冲突保留旧记忆，不直接截断、不自动转存长期记忆。降低预算后，在下一次读取、注入或写入时整理已有内容；失败不会把超额正文注入提示词。`clear` 可以直接清空超额记忆。辅助请求以 `purpose: memory` 记录请求和用量，聊天过程不清空已有思考和工具块。

## 工具

| 工具            | 参数与行为                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `global_memory` | `action: get/set/append/clear`；set/append 传 content，set/clear 必须传 expectedRevision；返回最终正文、修订号、Token 数、预算和是否整理 |
| `memory_create` | content：创建非空文档，返回 ID、修订号和创建时间                                                                                         |
| `memory_read`   | id、可选 offset/limit：正文按 Unicode 字符分页，默认 16000、最多 64000；返回来源、关联及 nextOffset                                      |
| `memory_update` | id、content、expectedRevision：完整替换正文，更新全文索引                                                                                |
| `memory_forget` | id、expectedRevision：永久删除正文、索引与关联                                                                                           |
| `memory_search` | query、conversationId、offset/limit、mode：返回摘要及 ID，默认每页 20、最多 100；空查询列出最近记忆                                      |
| `memory_link`   | id、conversationId、action: add/remove：维护关联；添加仅允许同一空间现存会话                                                             |

创建、读取正文和修改会自动关联当前会话；搜索列表不会。手动移除当前会话后，后续读取或修改会重新关联。创建会话记录不随关联变化，删除会话不级联删除记忆及历史关联。长期记忆文档数量没有应用层额度限制，单次工具返回通过分页控制。

覆盖、修改和删除前读取修订号；遇到 `memory_conflict` 重新读取后重试。并发追加在本进程按 workspace 串行，数据库修订检查同时防止其他实例覆盖。工具返回结构化错误；取消前已提交的写入不会撤销，取消或卸载时未提交的事务回滚。

## 文本召回与向量预留

正文和查询使用 Node 24 的 `Intl.Segmenter('zh-CN')` 分词、NFKC 规范化和英文小写化，再使用 PostgreSQL `simple` 全文查询与 GIN 索引。没有额外数据库分词扩展要求。长文按词边界分块；全部查询词可以分布在不同块，结果按相关度、更新时间和 ID 排序并按文档去重。搜索最多 128 个词，摘要最多 500 个字符；英文不做词干还原，中文分词结果取决于 Node 内置 ICU 词典。

搜索接口预留 `mode: vector`，当前返回 `memory_vector_unavailable`。本期不安装 pgvector、不配置嵌入模型、不创建向量列或索引。

## 验证

设置独立测试数据库连接 `ANTARESTRA_TEST_POSTGRES` 后运行：

```powershell
pnpm exec vitest run tests/integration/memory.test.ts --maxWorkers=1
```

测试使用真实 PostgreSQL 和模拟模型，覆盖主库复用、额外连接、存储、全文索引、预算整理、模板、版本冲突、会话关联与卸载取消；不代表真实提供商集成测试。没有测试连接串时 PostgreSQL 测试明确跳过。
