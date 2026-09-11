# Kysely 数据库实现

实现 `@antarestra/database` 定义的数据库服务。SQLite 使用 `better-sqlite3`，PostgreSQL 使用 `pg`，MySQL 使用 `mysql2`；MariaDB 通过 `mysql` 类型连接。每个服务上下文只允许一个后端，重复注册会拒绝并清理新连接。各实例不共享可变连接池或全局类型解析器。

## 配置

默认主配置已启用：

```yaml
plugins:
  database: {}
  plugin-database-kysely: {}
```

默认数据库为进程工作目录下的 `data/antarestra.sqlite`，缺少的父目录自动创建。`pnpm start` 的工作目录是 `apps/server`，因此默认文件位于该目录下；直接运行根目录启动脚本时路径随工作目录变化。生产部署建议使用绝对路径。

```yaml
plugins:
  database: {}
  plugin-database-kysely:
    type: sqlite
    filename: E:/Antarestra 数据/database.sqlite
```

`filename: ':memory:'` 适合隔离测试，重启或卸载连接后数据消失。

网络数据库只接受连接串环境变量的名称，不接受配置中的明文 URL。先通过部署环境注入 `ANTARESTRA_DATABASE_URL`，其值格式分别为 `postgres://用户:URL编码后的密码@地址:5432/数据库` 或 `mysql://用户:URL编码后的密码@地址:3306/数据库`。

```yaml
plugins:
  database: {}
  plugin-database-kysely:
    type: postgresql
    urlEnv: ANTARESTRA_DATABASE_URL
```

连接 MySQL 或 MariaDB 时将 `type` 改为 `mysql`。数据库和账号应预先建立；账号需要目标库的 CRUD、DDL 和索引权限，不需要全服务器管理权限。插件不会创建数据库、用户或修改授权。使用 UTF-8 数据库，并按业务需要明确字符串排序规则。

SQLite 不能配置 `urlEnv`，网络数据库不能配置 `filename`，未知配置字段会拒绝。连接池最多 10 个连接，连接及迁移锁等待上限为 30 秒。连接建立失败时不发布 `database`；连接池报告连接异常时撤销实现，依赖消费者随之清理。恢复由重新加载插件负责，不提供后台自动重连平台。

## 测试

```powershell
pnpm exec vitest run tests/integration/database.test.ts
```

默认运行真实 SQLite 测试。使用预先建立的专用测试数据库，将连接串注入 `ANTARESTRA_TEST_POSTGRES` 与／或 `ANTARESTRA_TEST_MYSQL`，再运行同一命令。不要将连接串提交到仓库。测试不使用 root；只需要测试数据库所属账号。

网络测试以随机 `test-UUID` 插件标识创建表，并有意留下失败或中断的迁移供断言；它们不会清空整个数据库。请使用专用测试库，完成后由测试库管理员清理本次测试命名空间。SQLite 测试临时文件会自动回收。

CI 在 Windows、Linux 执行 SQLite，在独立 Linux 服务任务执行 PostgreSQL 17 和 MySQL 8.4。远端任务是否通过以实际 CI 结果为准。本机验证过 PostgreSQL 17，以及通过 MySQL 方言连接的 MariaDB 12.0.2；MariaDB 的通过结果不能替代 Oracle MySQL 的运行结果。

完整 API、迁移规则与使用示例见 [数据库定义说明](../../definitions/database/README.md)。
