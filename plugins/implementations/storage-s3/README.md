# S3 存储实现

实现 `@antarestra/storage` 和 WebUI 的 S3 上传适配器。使用 AWS SDK v3，支持普通预签名 PUT、分片 PUT、合并、HEAD 核验、条件复制封存、签名下载和删除。默认 16 MiB 起使用分片，每片 8 MiB；分片最小 5 MiB。凭据仅由服务端读取，客户端只取得限时上传 URL。

## 本地 RustFS

参考 [RustFS Docker 官方文档](https://docs.rustfs.com/zh/installation/container/docker)。本项目单独使用 compose.storage.yml，与 PostgreSQL 开发环境互不影响。

```powershell
pnpm startdevstorage
pnpm initdevstorage
pnpm test:storage
```

第一条命令生成随机凭据到 Git 忽略的 `.env.storage.local` 并启动 RustFS，命名卷保留数据；API 仅绑定 `127.0.0.1:19000`，控制台仅绑定 `127.0.0.1:19001`。不使用公开默认密码。第二条创建本地私有桶 `antarestra-dev`，设置开发站点 CORS 与临时对象生命周期。第三条在独立随机测试桶与临时磁盘 SQLite 执行验证，结束后回收测试桶、文件和子服务；开发桶和容器保留。

启用根 antarestra.yml 中注释的 storage-s3 配置。将 `.env.storage.local` 中的两个环境变量加入启动环境，或在开发时执行：

```powershell
node --env-file=.env.storage.local --conditions=development --import tsx apps/server/src/index.ts
```

保留现有数据库环境变量配置；网页需要先 `pnpm build`。不要将凭据复制进 YAML 或提交到 Git。

停止容器但保留数据：

```powershell
docker compose --env-file .env.storage.local -p antarestra-storage -f compose.storage.yml stop
```

## 连接配置

- `id`：默认 `s3`，由 workspace-file.backendId 引用。
- `endpoint`：服务端 S3 地址。
- `publicEndpoint`：可选，下载方可访问的 S3 地址；在该地址上直接生成签名，不能签名后改写 host。用于 IM 图片时，还须让 NapCat 或飞书适配器所在机器可达；无需公网域名，同机可用 localhost，容器部署按实际网络配置。
- `bucket`、`region`、`accessKeyId`、`secretAccessKey`：连接配置。凭据使用配置加载器 `$环境变量` 引用。
- `forcePathStyle`：默认 true，适合 RustFS / MinIO；AWS 或其他供应商按要求修改。
- `multipartThreshold`、`partSize`：以字节计。

桶由管理员提前创建，插件不自动修改生产桶策略或 CORS。本地初始化脚本允许任意 Origin（`*`）、PUT / GET / HEAD、所有请求头，并暴露 ETag，以支持上传和跨域图片展示；私有桶仍通过签名 URL 鉴权。生产桶应按部署需要配置同等的浏览器访问能力。`uploads/` 必须配置一天过期和未完成分片一天终止作为崩溃回收兜底；不要给 `objects/` 配置短期过期。生产凭据应限制到目标私有桶及所需读写、分片、复制权限。

对象保留上传类型，不保存原始文件名、路径、空间 ID 或用户 metadata。常见位图、音视频、纯文本、CSV、Markdown 和 JSON 允许 inline；HTML、SVG、脚本、PDF 等未列入允许清单的类型使用 attachment，未知类型回退为 application/octet-stream。未指定下载响应覆盖时保留对象的 Content-Type 和 Content-Disposition；工作空间下载显式传入类型和编码文件名，使历史对象也可以内联展示。工作空间按上传文件扩展名识别类型，重命名保留该类型；缺少类型的历史记录按当前文件名识别。直接使用存储后端的生成文件调用方可以通过 BlobUpload.contentType 提供类型。直传临时对象使用 If-None-Match，最终对象使用条件 CopyObject；实现语义参考 [AWS CopyObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)。

已有文件记录保存后端 id，修改该 id 对应的桶/凭据不会迁移历史数据。更换存储位置需要单独迁移，不应直接把同一 id 指向空桶。本次仅验证 RustFS，不宣称已实测 AWS、R2 或 OSS。不同供应商的条件写入和 CORS 支持仍需实际验证。

WebUI 的 connect-src 默认只有同源。S3 插件会登记 endpoint / publicEndpoint 的精确连接源，虚拟主机模式同时登记桶域名，并在卸载时回收。切换连接地址后需刷新已打开的页面，以取得新的 CSP 响应头。

`temporaryUrl` 实现返回有效期 300 秒的 GET 预签名 URL 及 `expiresAt`，请求签名随查询参数携带，读取方无需 Cookie、Authorization 或额外请求头。此方法复用当前实例的签名客户端与响应头规则，不开放桶的匿名访问；普通 `download` 保持 60 秒有效期。临时 URL 在实际发送前签发，不在模型思考或排队前生成。
