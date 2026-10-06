# 网页工具

为 AI 提供本地搜索、网页阅读、全文查找、交互和截图。依赖 `ai`、`http`、`playwright`；保存截图另需工作空间文件服务和支持服务端写入的存储后端。

```yaml
plugins:
  playwright: {}
  web-tools:
    apiKey: $SERPER_API_KEY
    # 仅搜索 API 使用；省略或留空直连，此地址不是插件默认值。
    searchProxy: socks5://127.0.0.1:7890
    timeoutMs: 60000
    idleMinutes: 30
    maxSessions: 16
    maxPages: 8
    maxCharacters: 24000
```

搜索通过 `ctx.http` 请求 Serper；浏览器网络由 `playwright.proxy` 或 `playwright.args` 配置，PDF 独立 HTTP 获取不使用搜索代理。不修改全局代理或读取环境代理。Key 仅传给搜索 API，不进入工具参数、结果或日志。主配置中的环境变量引用由加载器解析，缺少变量会被加载器拒绝；插件本身允许不设置 `apiKey`，此时仅搜索返回配置错误。

从旧版迁移时启用 `playwright` 服务，将浏览器代理和视口配置移入该服务；`puppeteer.defaultViewport` 对应 `playwright.context.viewport`，缩放和移动设备选项直接放在 `context` 下，`acceptInsecureCerts` 对应 `context.ignoreHTTPSErrors`。已有 Puppeteer 消费插件可以继续使用原服务，网页工具不再依赖它。

## 工具

| 工具             | 主要参数与行为                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`     | `query` 或 `queries` 二选一；可选 `count/page/language/country/timeRange/domains`。时间范围为 `h/d/w/m/y`，域名不包含协议。返回独立查询结果与来源链接。     |
| `web_open`       | `url` 打开网页或 PDF，指定 `pageId` 复用页面；`action` 支持 `open/back/forward/reload/list/close`。默认直接返回页面内容。                                   |
| `web_snapshot`   | `pageId`；`view` 为 `combined/main/interactive/full`，`ref` 读取子树，`cursor` 继续读取。PDF 使用 `pdfPage`。                                               |
| `web_find`       | `pageId/text`；可选 `caseSensitive/includeHidden/offset/limit`。返回全文命中片段、节点引用或 PDF 页码。                                                     |
| `web_interact`   | `pageId/actions`；顺序执行最多 20 项操作，返回每步结果、执行后页面内容及页面清单。                                                                          |
| `web_screenshot` | `pageId/html/resourceId` 三选一；网页可选 `ref/fullPage/pdfPage`，HTML 固定整页。`saveToWorkspace` 默认 false，直接返回临时图片；true 保存并只返回资源 ID。 |

打开和交互已返回页面内容，通常不必紧跟快照工具。分页游标绑定保存内容，导航和交互后使用新快照。来源标识、最终 URL、标题与获取时间保留在结果中；搜索摘要不代表实际读取的正文。

默认快照使用 Playwright 公开的 `page.ariaSnapshot({ mode: 'ai' })`，输出 YAML 风格的角色、名称、状态、正文和 `[ref=…]` 引用，包含 iframe。引用添加文档命名空间，防止导航后误操作新页面；将 `ref=` 后的值原样传给工具即可。`main` 筛选正文区域（没有正文区域时返回全页），`interactive` 筛选控件；`full` 和全文查找使用独立 DOM 索引，保留已加载的隐藏内容及节点引用。密码输入值在原生快照和 DOM 输出中均脱敏。

查找覆盖已加载页面、可读取 iframe、开放 Shadow DOM，以及视口外内容；隐藏文本可显式加入。不包含尚未加载的无限滚动内容、其他分页、封闭 Shadow DOM 或图片文字。PDF 最多 32 MiB、500 页，支持文本层读取及逐页截图，扫描文档不进行 OCR。

主页面正文采集失败会返回 `page_read_failed` 及具体原因，不作为成功的空正文返回；子框架读取失败时保留其他区域的内容，并在 `warnings` 中报告原因。浏览器内执行的函数必须能独立序列化；局部辅助函数使用对象方法，避免 `tsx` 注入仅存在于宿主环境的 `__name` 辅助函数。

## 交互

支持 `click/double_click/fill/type/select/check/hover/scroll/drag/move/mouse_down/mouse_up/press/key_down/key_up/wait/dialog`。

- 优先传 `ref`；`fill/type` 使用 `text`，`select` 使用 `values` 或 `value`，`check` 使用 `checked`。
- `press` 使用 `key`，例如 `Control+a`；`scroll` 使用 `deltaX/deltaY`，可指定滚动元素；`drag` 使用 `ref/toRef`。
- 坐标操作使用截图的 `screenshotId/x/y`，按截图缩放换算。页面、视口或滚动状态变化后必须重新截图。
- `wait` 使用 `text/url/ref` 条件，可设置最长 30 秒的 `timeoutMs`；`dialog` 使用 `accept` 和可选 `text`。
- 导航、新页面、对话框或失败终止后续步骤，已执行步骤不回滚，点击和提交不自动重试。超时后先观察再决定下一步。
- 对话框阻塞期间返回上一次快照并标记 `snapshotStale`，处理后返回新快照。

不同页面通过显式 `pageId` 操作。不提供任意脚本执行、通用文件上传或下载管理。页面可标出可能的登录、验证码与 HTTP 错误，不自动绕过验证。网页内容是外部资料，不可覆盖用户指令。

Cloudflare `cf-mitigated: challenge` 响应、常见验证页标题和提示会生成 `verification_required`，与登录提示分开。主文档导航更新 HTTP 状态及验证标记，子资源和 iframe 的响应不会覆盖它。换用 Playwright 不保证网站放行新建的无头浏览器上下文。

## 会话和图片

会话键仅为 **`workspaceId + conversationId`**，不同操作者在同一空间会话内共享页面、Cookie、队列和结果，适用于 IM 群聊；工具范围由 AI 核心在 Run 启动时按 Agent 固定。不同会话和空间隔离。当前核心尚未在每次工具调用前统一复核被撤销的身份与权限，不能承诺活动运行即时失权。

URL 校验目前只限制 HTTP(S) 协议及嵌入凭据，没有阻止回环、私网或链路本地地址，也没有完整的重定向和子资源出站策略。给用户开放网页工具前，应按[安全评审](../../../docs/reviews/2026-10-03.md)修复这一边界，或在部署层明确隔离浏览器与 HTTP 出站网络。

浏览器任务按会话 FIFO 串行，包括操作及自动快照；不同会话和搜索并发。默认空闲 30 分钟回收。达到会话上限优先淘汰没有任务的最久未用会话，无可淘汰资源时报错。排队任务取消后不执行；正在执行的操作取消或超时会关闭上下文。会话删除、插件卸载、浏览器断开使旧标识失效；进程重启不恢复。

工具注册 `resultMode: 'structured'` 后返回 `{ content, images?, isError? }`，普通 JSON 工具不受影响。`ctx.ai.storeToolImage(context, image, persist)` 只接受正在执行的真实工具上下文。省略 persist 保持既有保存行为；截图工具显式传入 `saveToWorkspace`（默认 false）。

默认截图不写入工作空间，不要求文件存储服务。图片只在当前 AI 运行内存中保留，供支持图片输入的模型读取；运行结束即释放，后续运行只能看到不可用图片的文字说明，无法再次下载或发送。单次运行最多保留 32 MiB 临时图片，历史和事件只记录临时引用，不写入 Base64。

`saveToWorkspace: true` 复用工作空间附件写入、配额、访问权限和过期规则，只返回 `{ resourceId }`，不附带 `images`，模型不会收到图片正文。将资源 ID 交给 `im_prepare_image`，即可在最终 IM 回复中发送图片。

HTML 输入示例：

```json
{
  "html": "<!doctype html><meta charset=\"utf-8\"><style>body{padding:40px;font-family:sans-serif}</style><h1>报告</h1><p>图文内容</p>",
  "saveToWorkspace": true
}
```

已有 HTML 文件使用 `{"resourceId":"实际 HTML 文件资源 ID","saveToWorkspace":true}`。通过当前真实工具上下文读取可访问的文件，要求 `text/html` 类型、UTF-8 编码，最大 16 MiB。HTML 使用独立浏览器上下文，等待页面加载、字体和图片解码后截取整页，成功、失败或取消后均关闭，不占用网页会话页面。HTML 不接受 `ref/fullPage/pdfPage`；图片、样式等外部资源须使用绝对 URL 或 data URL，相对路径不会自动映射到工作空间文件。整页最多 2400 万像素，超限返回错误。

历史和事件只保存资源引用，模型请求期间解析为 Base64 图片内容。非视觉模型收到说明，附件仍保留。单张最大 8 MiB，整次上下文附件最大 32 MiB；超大截图返回错误，不静默裁切。

本地 `function/web_search` 与提供商原生 `web_search` 可以同时提交模型，不设置优先级。普通函数同名覆盖继续使用 AI 核心既有规则。

## 验证

```powershell
pnpm exec vitest run tests/integration/web-tools.test.ts tests/integration/ai.test.ts tests/integration/ai-provider.test.ts tests/integration/workspace-file.test.ts tests/integration/chat-tool-details.test.ts --maxWorkers=1
# 安装有系统 Chrome 时启用；截图存储使用测试替身，不等同于 S3 验证。
$env:WEB_BROWSER_TEST = '1'
pnpm exec vitest run tests/integration/web-tools.test.ts tests/integration/web-tools-dom.test.ts --maxWorkers=1
# 单独验证真实开发运行器的函数序列化、正文读取及交互，不访问外网。
pnpm exec tsx --conditions=development scripts/smoke-web-tools.ts
# 访问 /tests/fixtures/web-tools-preview.html 检查实际聊天组件。
pnpm exec vite --config tests/fixtures/web-tools-preview.config.ts --host 127.0.0.1
```
