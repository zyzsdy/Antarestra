# 主配置与插件加载

`@antarestra/config-loader` 属于启动基础设施，由 `apps/server` 直接装配。它读取 YAML、发现包元数据、校验配置并管理 Cordis 实例；安装在 server 依赖范围内的包不会因此自动启用。

## 配置文件与环境

服务端先选择基础配置：优先 `--conf=路径`，否则使用由入口文件位置计算的仓库根 `antarestra.yml`；若同目录存在 `<主配置文件名去掉扩展名>.local.yml`，自动合并后作为主配置。例如默认读取 `antarestra.yml` 和可选的 `antarestra.local.yml`。显式相对路径基于进程工作目录；基础文件不存在、覆盖文件无法读取或任一文件无效时明确失败，不回退。`pnpm start` / `pnpm dev` 的服务端工作目录为 `apps/server`，因此推荐传绝对路径，并给含空格的整个参数加引号。

```powershell
pnpm start '--conf=E:/Antarestra 配置/antarestra.yml'
```

主配置顶层支持 `plugins`、`loader`、`pluginPanel`。插件配置为平铺映射，不支持 Koishi 嵌套分组、表达式或 YAML 别名；`pluginPanel` 分组只影响界面展示，不改变依赖和加载顺序。

基础文件必须包含 `plugins` 映射；本地覆盖文件可以只写部分字段，也可以是空文件。映射逐层合并，数组、普通值和 `null` 整体覆盖；空映射不会清空继承内容。只查找一层覆盖文件，不递归查找。通常给 `--conf` 传基础文件，不传覆盖文件本身。监督进程、工作进程、重启和配置面板使用同一套合并规则。

例如本地文件可以只包含第三方插件：

```yaml
plugins:
  '@example/private-plugin': {}
```

本地 `~example` 会覆盖基础配置中同一实例的 `example` 启用状态，同时继承未覆盖的配置字段；反向启用同理。同一文件内不能同时声明两种状态。若要删除继承的插件或字段，使用仅在覆盖层支持的 `!delete` 标记：

```yaml
plugins:
  obsolete: !delete
  example:
    obsoleteOption: !delete
```

`null` 仍是普通配置值，不代表删除。覆盖文件的数组中不支持删除标记，因为数组按整体替换处理。

```yaml
loader:
  initializationTimeoutMs: 90000
  disposalTimeoutMs: 30000
  supervision: internal
plugins:
  logger: {}
  server: {}
  database: {}
  database-kysely:
    type: postgresql
    url: $ANTARESTRA_DATABASE_URL
```

字符串以 `$` 开头时，必须是完整的 `$ENV_NAME` 引用；变量名为字母或下划线开头，后续可含数字。不替换键，不进行字符串插值、表达式求值或递归展开。数组与嵌套配置值也支持引用。

两个配置文件先合并，再解析环境引用；被覆盖掉的变量不要求存在。环境优先级为进程环境（包括空字符串）高于 YAML 同目录的 `.env`。`.env` 可省略，不修改 `process.env`。禁用实例保留原始配置，不解析环境引用。已启用实例缺少变量或不符合 Schema 时不会正常激活，其他无关实例仍可启动。

管理器依据插件静态 JSON Schema 转换数字和布尔环境值；布尔只接受 `true` / `false`，数字必须合法且符合字段约束。没有类型声明时保持字符串。底层 `readConfig()` / `parseConfig()` 的旧式直接解析接口只作字符串替换，不承担 Schema 转换，完整运行装配使用配置管理器。

## 实例与模块解析

键名前加 `~` 禁用实例，例如 `~auth-local:9ce0b8f2`。重复实例的每个键都应采用 `插件名:随机哈希`，哈希为 8–32 位小写十六进制；使用 `createInstanceId(pluginId)` 创建并持久保存，重启不重建，复制实例需生成新标识。启用和禁用项不能复用同一实例标识。

默认只允许单实例，包括禁用项；需要插件清单显式声明 `multipleInstances: true`。相同包的短名和全名会归一。哈希只区分配置实例，不替代 `providerId`、后端 ID 等业务标识，也不保证代码具备多实例隔离能力。

短名 `example` 依次解析：

1. `@antarestra/example`
2. `@antarestra/plugin-example`
3. `antarestra-plugin-example`
4. `example`

带 scope 的名字精确匹配，YAML 键需加引号，例如 `'@other/example': {}`。仅候选包不存在时才继续查找；找到包但入口损坏、缺少内部依赖或导入报错时停止，不静默切换实现。Server 插件完整包名为 `@antarestra/plugin-server`；配置可明确使用 `plugin-server`，与启动程序包 `@antarestra/server` 区分。

模块支持默认函数、服务类、带 `apply` 的插件对象或命名导出的 `apply`。插件包需位于 server 可解析的依赖范围内，并含 `keywords: ["antarestra-plugin"]`；面板只发现安装范围内的插件，不递归展示任意传递依赖。安装命令示例：`pnpm --filter @antarestra/server add 包名`。

## 激活、更新与退出

插件按配置声明登记，服务注入由 Cordis 决定实际激活时间。建议先声明定义，再声明实现和消费者。单实例失败记录为错误，不回收其他无关实例；依赖恢复后消费者重新激活。

配置管理器支持版本校验、原子保存、在线启停、替换和显式应用外部改动。外部修改 YAML 不会自动应用。保存成功与运行成功分别反馈，文件写入和插件副作用不是同一事务。配置面板、Schema 和权限说明见[插件设置](../../plugins/features/config-panel/README.md)。

存在 `.local.yml` 时，面板读取合并结果，新增、编辑、启停、删除、分组和启动设置均只写入 `.local.yml`，基础文件保持原样；没有 `.local.yml` 时沿用直接写基础文件的行为。保存只记录必要的覆盖差异，保留未编辑的显式本地覆盖与注释，不把基础配置整份复制过去。删除继承项时自动写入 `!delete`，避免重启后重新出现。版本同时覆盖两个文件的原始内容及覆盖文件是否存在，任一文件修改、覆盖文件新增或删除均使旧版本失效；原子提交前再次检查。

初始化超时从依赖就绪后开始计时；清理超时会阻止继续创建同实例，需重启恢复。退出等待 `fiber.dispose()`，超过清理期限结束进程。`internal` 监督在授权重启（退出码 75）后拉起新进程，普通崩溃不会无限重启；`external` 由部署平台负责拉起。源码热更新另由 [HMR 插件](../../plugins/features/hmr/README.md) 提供。

配置管理器在创建 Fiber 前失败时，按包解析、环境变量读取或转换、配置校验、模块导入、实例注册区分阶段。面板提示中的诊断编号对应 `config-loader` 错误日志中的 `diagnosticId`；日志包含实例标识、阶段、白名单错误码及最多 8 层原因类型和错误码，可区分缺包、内部依赖缺失、错误导出和导入超时。保存或重新应用配置的预校验失败同样记录诊断。

诊断不记录任意异常的原文、堆栈、配置值或环境变量值；未知错误码归为 `UNKNOWN`，原因链去重并限制深度，不执行异常属性 getter。自定义异常没有受支持的错误码时，仅记录阶段和标准错误类型。Schema 热更新缓存问题仍见[评审记录](../../docs/reviews/2026-10-03.md)。
