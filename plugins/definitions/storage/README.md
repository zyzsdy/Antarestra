# Blob 存储定义

`@antarestra/storage` 只定义二进制对象后端与浏览器上传计划，不依赖 AI、文件路径、用户名或文件树。

通过 `ctx.storage.register(owner, id, backend)` 注册实现。标识重复明确拒绝，注册随所属上下文回收；卸载后通过旧后端引用调用也会拒绝。消费者使用 `backend(id)` 获取可用后端，不将注册表存在与网络可用等同。对象键统一由 `allocate` 生成 UUID，分为临时 `uploads/` 与封存 `objects/`。

后端应实现 begin、plan、complete、discard、remove、download、read。complete 必须校验真实长度并封存对象，能够重复调用；不得让旧上传凭证修改已提交对象。download 的可选响应头参数仅用于临时响应覆盖，不存入对象元数据。回收应幂等，网络错误由调用方保留记录重试。连接、凭据与客户端归各实现实例所有，不得存放模块级可变状态。

浏览器契约由 `@antarestra/storage/client` 导出，不包含服务端代码。`UploadPlan.driver` 在 WebUI `storage.uploaders` 插槽找到对应 `UploadExecutor`；执行器返回真实分片号和 ETag，并支持取消。
