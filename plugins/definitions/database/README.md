# 数据库服务与插件迁移

`@antarestra/database` 定义 `ctx.database`，消费插件只依赖此包及 `@antarestra/plugin-sdk`。默认导出的定义插件提供 `databaseProvider` 注册服务；实现连接成功后发布 `database`，所以 `inject: ['database']` 表示后端真正可用。

## 编写消费插件

```typescript
import { defineDatabasePlugin, defineMigration, values } from '@antarestra/database'
import type { Context } from '@antarestra/plugin-sdk'

interface Tables {
  notes: {
    id: string
    workspace_id: string
    content: string
    created_at: number
  }
}

const pluginId = '@example/notes'
const migrations = [
  defineMigration({
    id: '001_init',
    steps: [
      {
        kind: 'createTable',
        table: 'notes',
        columns: [
          { name: 'id', type: 'string', length: 64, primaryKey: true },
          { name: 'workspace_id', type: 'string', length: 64, notNull: true },
          { name: 'content', type: 'text', notNull: true },
          { name: 'created_at', type: 'timestamp', notNull: true },
        ],
      },
    ],
  }),
]

export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  async apply(ctx: Context) {
    const db = ctx.database.scope<Tables>(ctx, pluginId)
    // 此处已完成全部迁移。实际业务应先由服务端解析、鉴权 workspaceId。
    const workspaceId = '示例空间'
    await db
      .insertInto('notes')
      .values({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        content: '示例内容',
        created_at: values.timestamp(new Date()),
      })
      .execute()
    const notes = await db
      .selectFrom('notes')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .execute()
    // 将查询能力注册到所属上下文；示例没有注册 HTTP 或其他业务入口。
    void notes
  },
})
```

包装函数会补充 `database` 注入并保留 `inject` 中的其他必需依赖。无论通过配置加载器还是直接 `ctx.plugin()` 加载，均先迁移、再执行业务 `apply`。不需要建表的消费者也可以使用普通 `inject: ['database']`；需要手动控制时，可显式等待 `ctx.database.migrate(ctx, pluginId, migrations)`。

## 查询契约

PostgreSQL 专用消费者可调用 `await ctx.database.postgres<Tables>(ctx, pluginId, url?)`，返回同样的 CRUD、事务及绑定命名空间的 `migrate(migrations)`。主库为 PostgreSQL 时复用连接池，否则必须提供额外 PostgreSQL 连接串；额外连接跟随调用方及主后端回收，不改变主数据库服务。它允许使用 PostgreSQL 查询表达式，并支持迁移步骤 `{ kind: 'createFullTextIndex', table, name, column }`，为预分词文本创建 `to_tsvector('simple', column)` 的 GIN 索引。非 PostgreSQL 普通迁移拒绝此步骤。

`scope<Tables>(ctx, pluginId)` 返回类型化的 `selectFrom`、`insertInto`、`updateTable`、`deleteFrom` 和 `transaction(callback)`。查询支持关联、别名、普通及关联子查询、排序、分页和聚合。事务回调接收相同 CRUD 入口，不提供嵌套事务；事务结束后保存的入口拒绝继续执行。

逻辑表、列及索引标识为小写字母开头的 1–32 位字母、数字或下划线。插件标识为最多 128 字符的小写包名或稳定标识。表和索引物理名称为 `p_<插件标识 SHA-256 前 20 位>_<逻辑名称>`；元数据检查插件前缀冲突。索引名称在同一插件内唯一。

表属于插件定义，同一插件的不同实例共享表及迁移历史。实例数据应包含业务所需的 `instance_id`，空间数据应包含 `workspace_id`。作用域不自动增加租户过滤条件，也不是不可信插件的安全沙箱。

消费者不获得根 Kysely 实例、连接销毁方法、Schema 管理器或原始 SQL 执行入口。Kysely 查询构造器仍有数据库特定扩展；跨库代码不要使用 `RETURNING`、方言特定 upsert、原始 SQL、CTE、schema 限定名或数据库专属函数。字符排序规则、NULL 排序等数据库语义也需由业务明确处理；更换后端不自动搬迁已有数据。

| 声明类型    | 查询中的表示 | 默认值或约束                                               |
| ----------- | ------------ | ---------------------------------------------------------- |
| `string`    | `string`     | 默认上限 255 字符，可指定 1–1024                           |
| `text`      | `string`     | 文本                                                       |
| `integer`   | `number`     | JavaScript 安全整数范围，写入前可用 `values.integer` 检查  |
| `float`     | `number`     | 有限浮点数                                                 |
| `boolean`   | `0` 或 `1`   | `values.boolean` / `values.readBoolean` 转换               |
| `timestamp` | `number`     | UTC 毫秒，`values.timestamp` / `values.readTimestamp` 转换 |
| `json`      | `string`     | JSON 文本，`values.json` / `values.readJson` 转换          |

`readJson` 返回 `unknown`，业务自行校验解析结果。可空列的表类型需要显式写 `null`；Kysely 的 `KyselyColumnType`、`Insertable`、`Selectable`、`Updateable` 类型由定义包转导出，供区分查询、插入及更新类型。

## 跨插件事务

`ctx.database.transaction(owner, callback)` 提供同一连接上的多个命名空间查询入口。回调收到的 `transaction.scope<Tables>(pluginContext, pluginId)` 与普通 scope 使用相同的表名前缀和生命周期校验。参与插件通过自己的服务接收 transaction 并写自己的表，不应让调用方直接操作其他插件私有表。

例如 local 注册在同一个事务内调用 RBAC 的 `provision`，再写入本地账号。回调抛错时所有命名空间一起回滚；事务结束或任何参与上下文卸载后，保存的查询入口失效。该接口不提供跨数据库事务、嵌套事务或进程隔离。

## 声明式迁移

迁移声明为 `{ id, steps }`，ID 使用固定宽度数字及说明，例如 `001_init`、`002_add_index`，按字典序严格递增且不可重复。操作列表支持：

- `createTable`：`table`、`columns`；字段可声明 `primaryKey`、`notNull`、常量 `default`。
- `dropTable`：`table`。
- `addColumn`：`table`、`column`；不支持通过新增列增加主键。
- `renameColumn`：`table`、`from`、`to`。
- `dropColumn`：`table`、`column`。
- `createIndex`：`table`、`name`、`columns`、可选 `unique`。
- `dropIndex`：`table`、`name`。

多个字段声明 `primaryKey: true` 表示复合主键。主键仅支持字符串和整数，由应用生成值；不提供自增。新增非空列到已有数据表时需提供适当默认值。索引仍受数据库自身的键长限制。删除主键、关联或索引涉及的列，应先显式移除依赖约束或索引；首版不提供外键及复杂约束修改。

完整迁移列表在执行前进行结构校验；规范化对象键顺序、忽略未定义属性，保留数组与步骤顺序，再计算 SHA-256。校验和记录在 `antarestra_migrations`，联合主键为 `(plugin_id, migration_id)`。历史只能追加；历史缺失、顺序变化、内容改变或数据库历史比代码更新均阻止启动。不会根据当前表结构自动推断已执行的迁移。

SQLite、PostgreSQL 在数据库锁保护的事务中执行本次待运行迁移及历史写入，异常回滚本次事务。MySQL 使用同一连接的命名锁，迁移先写 `running`，完成写 `applied`，错误尽可能写 `failed`；进程崩溃时可能留下 `running`。两个进程同时迁移时，后获得锁者重新校验历史；锁等待上限为 30 秒。

MySQL 或 MariaDB 遇到 `running` / `failed` 时不会重放 DDL，应停止有关插件、备份数据库，并由管理员核对该迁移每条操作及实际结构，恢复到完整旧状态或完整新状态后修正对应记录，再启动。不要只删除失败记录就重试。首版不提供自动修复、回填回调、降级、`down` 或数据清除接口。

卸载消费者只撤销运行资源，不删除表与历史；卸载数据库实现会撤销服务并等待连接、事务清理。已保存的作用域和查询在所属上下文卸载后失效。恢复服务时重新校验迁移后启动消费者；生产升级中仍需自行安排备份及兼容性窗口。
