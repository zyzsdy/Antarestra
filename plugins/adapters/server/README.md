# HTTP 与静态资源服务

`plugins/adapters/server` 的包名是 `@antarestra/plugin-server`。主配置使用 `plugin-server`，避免与启动程序包 `@antarestra/server` 混淆。默认配置如下：

```yaml
plugins:
  plugin-server:
    host: 0.0.0.0
    port: 14451
    publicUrl: ''
    https: false
    cert: ''
    key: ''
    passphraseFile: ''
    debug: false
```

`port` 支持 0–65535，0 表示自动分配端口。HTTPS 开启时，`cert`、`key` 必须指向 PEM 证书和私钥文件；加密私钥可通过 `passphraseFile` 读取密码。文件路径相对于进程工作目录（使用 `pnpm start` 时为 `apps/server`），建议使用绝对路径。密码只去掉末尾换行，保留其他空白；关闭 HTTPS 时不读取这些文件。HTTP 与 HTTPS 二选一，不同时开启两个监听端口。证书无效、文件读取失败或端口占用都会使启动失败。

`publicUrl` 是可选的无凭据 HTTP/HTTPS 外网地址，按配置原样保留；为空时不从请求头推断。插件提供只读 `ctx.server.publicUrl` 和 `ctx.server.address`，后者在监听成功后包含实际地址与端口，关闭后为 `undefined`。其他插件通过 `ctx.server.url(path)` 生成交付给用户的完整站内链接：优先使用 `publicUrl`，未配置时将通配监听地址换成本机 `127.0.0.1` 并使用实际监听端口。

消费插件安装 `@antarestra/plugin-server` 工作区依赖并声明 `inject: ['server']`，使用 Koa 的 `ctx/next` 接口：

```typescript
import type { Context } from '@antarestra/plugin-sdk'
import type {} from '@antarestra/plugin-server'

export const inject = ['server']

export function apply(ctx: Context): void {
  ctx.server.use(ctx, async (http, next) => {
    http.set('X-Example', 'enabled')
    await next()
  })

  ctx.server.route(ctx, 'GET', '/users/:id', (http) => {
    http.body = { id: http.params.id }
  })

  ctx.server.static(ctx, '/assets', '/absolute/path/to/public')
}
```

包导出 `HttpServer`、`Config`、`HttpContext`、`Middleware`、`ApiHandler` 和 `Dispose`。三个注册方法均要求显式传入所属 Cordis 上下文，返回可等待、幂等的撤销函数，也随所属插件卸载自动回收。`route` 支持多个处理函数，自动加 `/api` 前缀，因此示例地址为 `/api/users/:id`；重复填写 `/api`、重复的方法与路径，以及覆盖 `/health` 都会被拒绝。路径匹配区分大小写，末尾斜杠等价，重叠路由按注册顺序匹配。GET 自动支持 HEAD，OPTIONS 返回允许的方法，已知路径的方法不匹配返回 405。

处理顺序为最外层错误捕获、按注册顺序执行的洋葱中间件、API 路由或静态文件、404。`/api` 及其下级路径不会回落到静态文件。静态挂载仅支持 GET/HEAD，可挂载 `/`，嵌套目录按最长前缀优先；文件不存在时继续尝试下一个匹配挂载。支持目录的 `index.html`，不支持目录列表或 SPA 回退，禁止点文件、路径越界及链接到根目录外的文件。注册变化只影响后续请求，已经进入处理链的请求继续使用原快照。

内置 `GET /api/health` 只返回 `{ "status": "ok", "time": "UTC ISO 8601 时间" }`。插件不默认添加请求体解析、CORS、鉴权或网页挂载；中间件可短路请求，因此消费插件需要自行保证自己的中间件策略符合预期。

中间件和 API 抛出的异常统一返回 500，包括 `http.throw(401)` 这样的异常；需要返回正常业务状态时直接设置 `http.status` 和 `http.body`。默认错误正文为 `{ "error": "Internal Server Error" }`；`debug: true` 时返回包含消息、堆栈和原因链的中文 HTML 页面，动态内容全部转义，页面没有脚本、外部资源或模板依赖。错误响应禁止缓存并移除旧响应头，不额外展示请求头、请求体或配置。错误信息本身由抛错插件负责避免包含凭据。

响应头已经发出时无法改写为 500，此时终止连接。Node 可读流及 Web ReadableStream/Blob 的传输错误同样由最外层处理；脱离请求链的后台任务异常不属于这一捕获范围。关闭服务时先停止接收连接，最多等待五秒，随后关闭残余连接。消费插件仍需自行清理后台任务与业务资源。同一上下文只提供一份 `server` 服务；不同上下文实例互相独立。插件热更新由独立 HMR 插件提供，Server 本身不构成安全沙箱。
