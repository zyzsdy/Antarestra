# 工作空间文件

`@antarestra/plugin-workspace-file` 为聊天、Agent 与其他可信入口提供路径文件系统。根目录始终为 `/`。物理存储只接收随机对象键，原始名称、路径、空间归属、配额与上传状态保存在本插件的数据库命名空间中。

## 启用

定义插件 `storage`、数据库、RBAC 与 server 必须先就绪。`storage-s3` 注册 `s3` 后端；WebUI 和 AI 为可选依赖，其卸载不停止文件元数据服务。根配置已启用 storage 和 workspace-file，S3 连接示例默认注释，避免没有凭据时影响现有启动。

```yaml
plugins:
  # 保留已有 database、server、rbac、webui 等配置。
  storage: {}
  storage-s3:
    endpoint: http://127.0.0.1:19000
    region: us-east-1
    bucket: antarestra-dev
    accessKeyId: $ANTARESTRA_S3_ACCESS_KEY
    secretAccessKey: $ANTARESTRA_S3_SECRET_KEY
    forcePathStyle: true
  workspace-file:
    backendId: s3
    defaultQuota: 1073741824
    maxFileSize: 1073741824
    uploadMinutes: 30
```

默认空间容量和单文件上限均为 1 GiB，上传凭证有效期 30 分钟。单文件配置上限为 4 GiB（使用 S3 CopyObject 封存），超大文件不在当前版本范围内。每个空间最多 10000 个文件、目录与尚未回收的上传记录。已有空间的配额不随默认值变化，必须在管理控制台修改。空间元数据采用单行 JSON 与数据库 CAS；适用于当前有界目录，不能宣称海量文件索引。

## 用户与管理员入口

- `/files/`：当前空间文件，目录逐层浏览、50 项分页、上传、下载、移动 / 重命名、建目录、删除空目录和文件。
- `/admin/storage/`：20 项服务端分页，按中文标签或 ID 查询、查看已用和上传预占、以字节修改配额。需要 `admin.console.view` 与 `admin.storage.manage`。
- 聊天的“添加内容”菜单与图片粘贴调用 `uploadAttachment`，使用配置 `attachmentDirectory`（默认 `/chat-attachments`）与随机子目录，保存正式附件 ID 和访问地址；AI 资源解析器在当前运行的空间内读取附件。
- AI 就绪后注册 `workspace_file_list` 与 `workspace_file_read`。后者通过 `path` 读取最多 1 MiB 的 UTF-8 文本，也可通过 `resourceId` 读取文本或最多 8 MiB 的 PNG、JPEG、GIF、WebP 图片；两个参数只填一个。图片复用结构化工具结果，视觉模型会收到实际图像内容，历史仅保存资源引用。Agent 配置仍须允许这些工具；只有文件工具执行期间签发的临时凭证可获得空间授权，同时核对 AI 核心的当前运行、主体和空间。

IM 历史中超过自动附图数量上限的 `[图片,ID]`，可调用 `workspace_file_read({ "resourceId": "ID" })` 按需查看。ID 必须对应当前空间仍然存在的已存储文件；下载失败、已过期或其他空间的资源不能读取。此功能不改变自动附图数量限制，仍受工具单图 8 MiB、模型上下文附件总量 32 MiB 和模型图片输入能力限制。

文件操作需要 `workspace.file.use`，默认开放给 user/admin。每次操作重新解析可信入口的空间，拒绝伪造授权对象，客户端传入其他 workspaceId 会返回 403。管理员的 system 权限不用于越权下载其他空间文件。

文件管理通过 RBAC 的 `workspaceDirectory()` 只读取统一持久化的空间目录，不调用身份插件，不需要认证来源提供文件空间枚举接口。任意来源在正常身份解析中返回可信的 `actorId`、`workspaceId` 时，RBAC 自动登记；没有请求的业务通过通用 `ensureWorkspace` 在创建事务中登记。本地账号、IM、未来 OAuth 或 Zero Trust 等来源遵循同一条路径，具体契约见 [RBAC 空间管理目录](../../definitions/rbac/README.md#空间管理目录)。

每次管理查询同步目录名称，再对已收录空间统一搜索和分页；同 ID 保留文件、上传状态和已有配额。空间登记不依赖文件服务已安装，也不依赖首次文件访问；即使文件插件在身份来源卸载之后才加载，仍能看到已登记空间。账号或空间停用不会删除目录，也不会因目录可见而获得文件访问权。历史文件记录保留，目录不主动发现尚未导入、创建或验证的外部空间。

## 上传协议

1. `POST /api/workspace-files/uploads`，提交 `{ path, size }`。服务端校验路径，原子预占空间配额，持久化上传会话，返回随机 `token`、过期时间和 `plan`。
2. 实现插件通过 WebUI `storage.uploaders` 插槽解释 plan。S3 使用预签名 PUT 或分片 PUT，浏览器直接上传到存储服务器，不经过应用服务器传输文件体。
3. `POST /api/workspace-files/uploads/:token/complete`，提交 `{ parts: [{ number, etag }] }`。服务端核验对象真实长度、合并分片、封存到新的随机对象键，再原子登记文件与已用容量。重复确认在上传记录保留期间不重复计费。
4. `POST /api/workspace-files/uploads/:token/cancel` 取消并释放预占。失败或中断的浏览器客户端尽力执行取消；丢失响应的任务由过期回收处理。

S3 直传签名强制 `If-None-Match: *`，临时对象在凭证有效期内不能被覆盖；确认时使用条件复制并重新核验长度，最终对象没有浏览器上传凭证。同名路径拒绝覆盖。签名下载有效 60 秒，文件名只作为本次响应头覆盖参数，不写入对象元数据。

取消不立即删除临时对象，避免仍有效的 PUT 链接重新创建无人管理的对象。每分钟扫描，凭证过期后一小时回收临时对象、未完成分片及未提交的最终对象，失败保留任务重试。过期但未取消的预占在成功回收后释放。S3 桶还必须配置 `uploads/` 一天过期及未完成分片一天终止，处理进程在创建分片与写数据库之间崩溃的极小窗口。已用容量是已登记文件的逻辑字节数，不包含临时副本、待回收对象或桶版本历史。

降低配额不会删除文件；可低于已用容量，此时拒绝新上传，已预占任务仍允许完成。设为 0 停止新上传。删除先移除路径并登记持久化回收任务，物理删除由后台重试。

## 可信服务调用

```ts
// 所属插件应 inject: ['workspaceFile']。source/request 必须来自已注册的真实入口。
const access = await ctx.workspaceFile.authorize(source, request)
await ctx.workspaceFile.list(access, '/', 1)
const ticket = await ctx.workspaceFile.begin(access, { path: '/upload/example.txt', size: 12 })
// 按 ticket.plan 上传，然后传实际分片回执。
await ctx.workspaceFile.complete(access, ticket.token, parts)
const bytes = await ctx.workspaceFile.read(access, '/upload/example.txt')
```

浏览器业务插件通过 `@antarestra/plugin-workspace-file/client` 的 `filesSlot` 获取 `WorkspaceFilesClient`，仅调用 `upload(file, path, signal, progress)`，不依赖具体 S3 实现。后续 OSS 等实现可注册新的 driver 上传适配器。服务端 `spaces` 与 `quota` 是可信管理服务方法，HTTP 层在调用前独立检查管理员权限。

聊天使用 `uploadAttachment(file, signal, progress)` 和 `remove(id, signal)`。上传确认返回 `{ id, path, filename, mimeType, size, url }`，ID 在移动文件后保持不变；重复删除旧 ID 不影响同名新文件。`GET /api/workspace-files/resources/:id` 查询详情，`GET .../:id/content` 鉴权后签发短时访问链接，`?download=1` 强制附件下载；`POST .../:id/remove` 删除文件、立即释放逻辑配额并尝试物理回收，失败保留回收任务。所有查找仅限服务端授权空间，文件或 S3 对象不存在时返回 410。存储实现可提供 `exists` 检查，S3 使用 HEAD。

图片资源解析器支持 PNG、JPEG、GIF、WebP，其他格式作为普通文件保存；模型是否接收由其接口决定。附件内容只在调用期间经 `ResolvedResource` 交给模型驱动，历史与请求快照仅保留引用。单附件 AI 读取上限 16 MiB，与空间上传配额是不同限制。

## 验证

`tests/integration/workspace-file.test.ts` 使用内存 SQLite 与内存 blob 后端验证权限、配额并发、目录、重载和清理，不代表真实 S3 验证。`pnpm test:storage` 使用真实 Docker RustFS 与磁盘 SQLite，验证直传、分片、字节内容、随机键、不可覆盖、跨空间拒绝和重载；不使用真实模型密钥。
