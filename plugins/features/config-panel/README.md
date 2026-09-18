# 插件设置面板

`@antarestra/plugin-config-panel` 在 `/admin/plugin-config-panel/` 提供插件运行与配置管理，默认启用。系统重启还有独立入口 `/admin/system-restart/`。

## 权限与安全边界

RBAC 固定声明 `admin.plugins.manage` 与 `admin.system.restart`，默认授予 admin；两者互不替代，页面还要求 `admin.console.view`。插件管理是系统最高权限，能读取主配置中的原始明文值、调整数据库和认证配置；只应授予完全可信的管理员。环境引用仅展示 `$变量名`，不会返回解析结果。配置响应禁止缓存，网页不持久保存配置或密码。

重启每次验证当前账号密码；认证提供者需注册二次认证能力。停用 RBAC 后 HTTP 层默认拒绝受保护 API；健康接口及由所属插件明确声明的公共接口除外。现有认证提供者在重载或进程重启后撤销旧会话，恢复后需要重新登录。

## 操作规则

- 主列表展示所有配置实例，未配置的已安装包出现在添加列表。添加只写入禁用配置，不安装依赖。
- 首次进入与手工刷新读取列表，不进行后台轮询。操作完成后使用任务结果中的快照同步配置与状态。
- 绿点表示就绪，红点表示启动失败或依赖不可用，灰点表示禁用；处理中有独立文字说明。
- 保存先校验、写盘，再清理旧实例并重新加载。运行失败保留新配置；保存与生效分别反馈。
- 禁用实例可保存不完整配置。启用前校验 Schema 及环境引用；校验失败不改变文件或旧实例。
- 别名、单层分组、排序仅影响共享展示，不改变启动顺序。删除分组将成员移入未分组。
- 删除配置会立即卸载，依赖包保留。清理失败保留临时运行记录，要求重启恢复。
- 缺少服务依赖不阻止保存或删除；实例显示等待依赖，由 Cordis 在服务恢复后继续启动。
- 服务插件重载会连带暂停和重新初始化消费者；无关实例继续运行。
- 外部修改文件不自动应用；刷新后逐实例应用或重启。版本冲突保留草稿，不覆盖他人修改。
- 配置写入使用原子文件替换，保留无关字段和注释；无法将文件保存与所有插件副作用组成同一事务。

修改监听地址、禁用基础服务或设置面板本身可能失去后台入口。执行前复制新入口；必要时手动编辑启动时 `--conf` 指定的主配置并重新启动进程。

## 加载器设置

```yaml
loader:
  initializationTimeoutMs: 90000
  disposalTimeoutMs: 30000
  supervision: internal
plugins:
  plugin-config-panel: {}
pluginPanel:
  groups: []
  instances: {}
```

固定“加载器设置”入口不可停用或删除；修改在下一启动周期生效。初始化计时从依赖就绪、插件开始执行后起算。清理超时禁止再次创建同实例；进程重启超过清理期限强制退出。进程内计时器无法中断同步死循环，不构成插件沙箱。

`internal` 默认由内置监督进程拉起新工作进程，支持 `pnpm start` 与 `pnpm dev`。`external` 收到重启指令后以 **75** 退出，平台必须自行配置重启策略。普通崩溃不会在内置监督中无限重启。外部数据库不随之重启。

## 插件元数据与配置 Schema

插件清单必须包含 `keywords: ["antarestra-plugin"]`。可添加的包必须位于服务端可解析的依赖范围内，不会递归扫描 pnpm 存储中的任意传递依赖。

```json
{
  "antarestra": {
    "configSchema": "./config.schema.json",
    "multipleInstances": false
  }
}
```

Schema 使用 JSON Schema Draft 2020-12，保存在包内静态 JSON 文件，不加载远程引用。用 `title`、`description` 描述中文表单，敏感字段用 `x-sensitive: true`。服务器使用同一 Schema 补默认值并校验，插件只补运行条件检查。SDK 的 `@antarestra/plugin-sdk/schema` 提供 `schemaConfig`、`validateConfig` 和环境变量解析适配。

表单支持对象、基本类型、枚举、数组；数组输入采用 JSON，复杂条件或其他结构可切换 YAML，服务端仍完整校验。默认值只在运行时补齐。数字和布尔字段的环境引用严格转换，布尔值只接受 `true`、`false`。

默认单实例，禁用条目也计数。仅明确设置 `multipleInstances: true` 可重复添加。短名和完整包名按实际包归一；手写重复配置时整个重复集合不加载。现有 auth-local 保留独立 providerId 的多实例支持；重复 providerId 仍按启动错误处理。

## API 与验证

`/api/plugin-config-panel` 提供快照、实例详情、包发现、配置修改、布局、加载器设置、逐实例应用和操作查询。写操作携带配置版本；长操作返回 202 与任务 ID，查询结果包含 `saved`、运行状态及运行代次。任务只保存在内存，进程重启后不恢复历史任务。

`POST /api/plugin-config-panel/restart` 独立校验重启权限与密码。健康响应的 `X-Antarestra-Generation` 仅用于判断进程代次变化，不表示全部插件成功。网页在恢复后重新登录查看各实例状态。

新增测试位于 config-manager、config-panel 和 supervisor 集成测试，覆盖真实 SQLite、HTTP 授权、配置冲突、初始化与清理超时及真实 Node 进程重启。现有 HMR 1.1.x 的刷新入口通过 SDK 适配接入管理队列；升级 HMR 时必须重新验证该适配。
