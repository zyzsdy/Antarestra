# Playwright 浏览器服务

通过 `ctx.playwright` 提供按需启动的 Chromium 浏览器。依赖 `playwright-core`，安装依赖时不下载浏览器；默认使用已安装的系统 Chrome。可配置 `channel: msedge` 使用系统 Edge，或通过 `executablePath` 指定 Chromium。使用 `channel: chromium` 前需自行安装对应的 Playwright 浏览器。

```yaml
plugins:
  playwright:
    channel: chrome
    headless: true
    # userAgent: 自定义值；省略时自动生成
    timeout: 30000
    actionTimeout: 10000
    context:
      viewport:
        width: 1280
        height: 720
      locale: zh-CN
```

`args` 追加启动参数，`proxy` 使用 Playwright 的 `server/bypass/username/password` 配置。代理只作用于此服务，不修改 HTTP 服务、环境代理或用户浏览器。`context` 支持视口、缩放、触摸、移动设备、语言、时区、User-Agent 和证书校验设置；完整字段见 `config.schema.json`。

`userAgent` 设置所有新建隔离上下文的默认 User-Agent，省略时保留浏览器原生 UA 中的系统信息，将 Chrome 版本替换为实际运行版本，并追加 `Anta/<根 package.json 的 version>`。无头浏览器的 `HeadlessChrome` 标识统一为 `Chrome`。系统信息遵循浏览器 UA 格式，例如 Windows 11 仍可能显示 `Windows NT 10.0`。已有的 `context.userAgent` 配置优先于顶层 `userAgent`。

```ts
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/playwright'

export const inject = ['playwright']
export async function apply(ctx: Context) {
  const content = await ctx.playwright.withPage(ctx, async (page) => {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    return page.ariaSnapshot({ mode: 'ai' })
  })
  // content 是外部网页资料，消费方负责处理不可信内容及敏感字段。
  void content
}
```

每次 `createPage(owner)` 创建独立 BrowserContext，返回 `{ page, close }`。`withPage(owner, action)` 在成功或异常时自动关闭整个上下文及弹窗。长期持有页面时必须调用 `close()`；调用方卸载也会等待回收，包括尚未完成的页面创建。服务卸载关闭浏览器，断开后下次调用重新启动，并发首次调用共享一次启动。

网页工具使用此服务；已有 Puppeteer 服务继续供其他插件使用，两者不会共享 Cookie 或页面。隔离上下文不复用个人浏览器登录态，也不保证通过网站的自动化访问验证。

验证：`pnpm exec vitest run tests/integration/playwright.test.ts --maxWorkers=1`。真实系统 Chrome 的工具链验证：`pnpm exec tsx --conditions=development scripts/smoke-web-tools.ts`。
