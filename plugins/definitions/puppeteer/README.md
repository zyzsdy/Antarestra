# 无头浏览器服务

启用 `puppeteer: {}` 后通过 `ctx.puppeteer` 打开网页、读取渲染结果、生成 HTML 截图，或使用原生 Puppeteer Page API。服务使用 `puppeteer-core`，不会在安装依赖或首次调用时下载浏览器。

## 配置

```yaml
plugins:
  puppeteer:
    # 省略后自动查找；Windows 路径建议使用 YAML 单引号。
    executablePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    headless: true
    # userAgent: 自定义值；省略时自动生成
    args: ['--lang=zh-CN']
    timeout: 30000
    protocolTimeout: 180000
    acceptInsecureCerts: false
    defaultViewport:
      width: 1280
      height: 720
      deviceScaleFactor: 1
```

自动查找优先复用 `@puppeteer/browsers` 维护的 Chrome 安装位置，再检查系统 Chromium 常见位置和 PATH。显式路径不可用时直接报错，不静默替换。相对路径基于服务进程工作目录。系统浏览器版本需与 Puppeteer 兼容。

`userAgent` 在服务创建页面后、交给调用方前设置，同时作用于请求头和 `navigator.userAgent`；省略时保留浏览器原生 UA 中的系统信息，Chrome 版本遵循原生缩减格式 `Chrome/<实际主版本>.0.0.0`，并追加 `Anta/<根 package.json 的 version>`。无头浏览器的 `HeadlessChrome` 标识统一为 `Chrome`。系统信息遵循浏览器 UA 格式，例如 Windows 11 仍可能显示 `Windows NT 10.0`。此设置适用于 `createPage`、`withPage`、`read` 和 `screenshot` 创建的页面。

浏览器在首次操作时启动，并发首次调用共用一次启动。启动失败后允许重试，浏览器断开后下次调用重新启动。未安装浏览器不会影响仅启用插件的服务启动。

## 调用

消费插件通过 `pnpm --filter 目标包 add '@antarestra/puppeteer@workspace:*'` 添加依赖，并在 TypeScript 项目引用中加入本插件。

```ts
import type {} from '@antarestra/puppeteer'
import type { Context } from '@antarestra/plugin-sdk'

export const inject = ['puppeteer']
export async function apply(ctx: Context) {
  const result = await ctx.puppeteer.read(ctx, 'https://example.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  // result 包含最终 url、title、可见 text、html 和主文档 status。

  const png = await ctx.puppeteer.screenshot(ctx, '<h1>你好，世界</h1>', {
    viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
    screenshot: { type: 'png', fullPage: true },
  })
  // 返回 Buffer，保存或上传由调用方处理。

  const title = await ctx.puppeteer.withPage(ctx, async (page) => {
    await page.goto('https://example.com')
    await page.waitForSelector('h1')
    return page.title()
  })
}
```

`withPage` 在回调结束或抛错时关闭整个隔离浏览器上下文，弹窗也会一起关闭。需要跨多步保留页面时，使用 `const handle = await ctx.puppeteer.createPage(ctx)`，通过 `handle.page` 操作，最后在 `finally` 中 `await handle.close()`；重复关闭无副作用。

每次操作拥有独立 BrowserContext，不共享 Cookie 或本地存储。第一个参数必须是调用方的插件上下文，调用方卸载自动关闭其上下文；服务卸载会等待关闭浏览器，包括尚未完成的启动。这里不使用日常浏览器的用户资料目录，也不默认添加 `--no-sandbox`。

`read` 返回浏览器渲染后的 DOM 和正文，并非文章抽取或 Markdown 转换。对于动态网页可通过 `withPage` 自行等待业务元素；HTML 截图可用 `wait` 指定 `setContent` 的加载等待参数。HTTP 服务的按请求代理不会改变浏览器网络；如需整个浏览器使用代理，可在本插件 `args` 中显式传入浏览器代理参数。

## 验证

```powershell
# 不需要安装 Chrome 的生命周期测试
pnpm exec vitest run tests/integration/puppeteer.test.ts --maxWorkers=1
# 本机真实 Chrome：读取、PNG 尺寸、Cookie 隔离、异常回收和进程退出
pnpm exec tsx --conditions=development scripts/smoke-puppeteer.ts
# 如需指定验证路径，在运行前设置 $env:CHROME_PATH
```

上游参考：[启动选项](https://pptr.dev/api/puppeteer.launchoptions)、[系统 Chrome 查找](https://pptr.dev/browsers-api/browsers.computesystemexecutablepath)。
