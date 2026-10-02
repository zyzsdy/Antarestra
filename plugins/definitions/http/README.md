# HTTP 请求服务

启用 `http: {}` 后通过 `ctx.http` 提供统一请求库。插件没有代理配置项，代理只在调用参数或调用方创建的客户端中指定。

## 复用与边界

项目原先只有模型目录查询直接使用原生 `fetch`，没有统一请求服务。这里复用兼容 Cordis 4 的 `@cordisjs/plugin-http`，保留其方法、响应解码、错误类型与客户端扩展，不另写请求库。代理复用 Undici 的 `ProxyAgent`；其 SOCKS5 支持目前由上游标记为实验性，集成测试覆盖真实本地 SOCKS5 握手和代理端域名解析。

插件使用独立 Undici 实例接口和连接池，服务端即使带 `--expose-internals` 也不切换到 Node 内置 Undici。不设置全局代理、不读取环境代理；已有原生 `fetch` 调用不会被自动改道。WebUI 中的浏览器 `fetch` 仍由浏览器执行。

## 调用示例

消费插件通过 `pnpm --filter 目标包 add '@antarestra/http@workspace:*'` 添加依赖，并在 TypeScript 项目引用中加入本插件。

```ts
import type {} from '@antarestra/http'
import type { Context } from '@antarestra/plugin-sdk'

export const inject = ['http']
export async function apply(ctx: Context) {
  const direct = await ctx.http.get<{ ok: boolean }>('https://example.com/api')
  const proxied = await ctx.http.get('https://example.com/page', {
    proxyAgent: 'socks5://127.0.0.1:1080',
    responseType: 'text',
    timeout: 30_000,
  })
  const posted = await ctx.http.post(
    'https://example.com/api',
    { value: 1 },
    {
      proxyAgent: 'http://127.0.0.1:8080',
    },
  )
}
```

- `proxyAgent` 支持 `http://`、`https://`、`socks5://`（以及 `socks://`）。认证使用 URL 中的用户名与密码，调用方应从凭据来源读取并正确 URL 编码，不写入仓库或日志。
- `ctx.http.extend({ baseUrl, headers, proxyAgent })` 创建调用方专用客户端；不改变其他调用。对该客户端的某次请求传入 `proxyAgent: ''` 可显式直连。
- `get`、`post`、`put`、`patch`、`delete` 自动解码响应，并对错误状态抛出 `Http.Error`。可用 `responseType` 指定 `json`、`text`、`arraybuffer`、`stream` 等，或用 `validateStatus` 自定义状态判断。
- `await ctx.http(url, options)` 返回原始 `Response`，由调用方检查状态并消费或取消响应体。
- `signal` 支持主动取消。上游 `timeout` 作用于获取响应头之前；读取长响应体时应传入覆盖完整操作的 `AbortSignal.timeout(...)`。
- 调用方卸载会取消其请求及响应体读取；服务卸载会取消全部请求并等待连接池销毁。连接池按服务实例及代理地址复用。

## 验证

```powershell
pnpm exec vitest run tests/integration/http.test.ts --maxWorkers=1
```

上游参考：[Cordis HTTP](https://github.com/cordiverse/http)、[Undici 代理接口](https://github.com/nodejs/undici/blob/main/docs/docs/api/ProxyAgent.md)。
