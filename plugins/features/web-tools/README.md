# 网页工具

为 AI 提供本地搜索、网页阅读、全文查找、交互和截图。依赖 `ai`、`http`、`puppeteer`；保存截图另需工作空间文件服务和支持服务端写入的存储后端。

```yaml
plugins:
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

搜索通过 `ctx.http` 请求 Serper；浏览器网络由 `puppeteer.args` 配置，PDF 独立 HTTP 获取不使用搜索代理。不修改全局代理或读取环境代理。Key 仅传给搜索 API，不进入工具参数、结果或日志。主配置中的环境变量引用由加载器解析，缺少变量会被加载器拒绝；插件本身允许不设置 `apiKey`，此时仅搜索返回配置错误。

## 工具

| 工具             | 主要参数与行为                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_search`     | `query` 或 `queries` 二选一；可选 `count/page/language/country/timeRange/domains`。时间范围为 `h/d/w/m/y`，域名不包含协议。返回独立查询结果与来源链接。 |
| `web_open`       | `url` 打开网页或 PDF，指定 `pageId` 复用页面；`action` 支持 `open/back/forward/reload/list/close`。默认直接返回页面内容。                               |
| `web_snapshot`   | `pageId`；`view` 为 `combined/main/interactive/full`，`ref` 读取子树，`cursor` 继续读取。PDF 使用 `pdfPage`。                                           |
| `web_find`       | `pageId/text`；可选 `caseSensitive/includeHidden/offset/limit`。返回全文命中片段、节点引用或 PDF 页码。                                                 |
| `web_interact`   | `pageId/actions`；顺序执行最多 20 项操作，返回每步结果、执行后页面内容及页面清单。                                                                      |
| `web_screenshot` | `pageId`；可选 `ref/fullPage/pdfPage`。默认截取视口，返回图片附件及坐标信息。                                                                           |

打开和交互已返回页面内容，通常不必紧跟快照工具。分页游标绑定保存内容，导航和交互后使用新快照。来源标识、最终 URL、标题与获取时间保留在结果中；搜索摘要不代表实际读取的正文。

快照通过语义 DOM 和浏览器可访问名称保留正文、层级、控件名称与状态，精简输出和完整文本索引分开。查找覆盖已加载页面、可读取 iframe、开放 Shadow DOM，以及视口外内容；隐藏文本可显式加入。不包含尚未加载的无限滚动内容、其他分页、封闭 Shadow DOM 或图片文字。PDF 最多 32 MiB、500 页，支持文本层读取及逐页截图，扫描文档不进行 OCR。

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

## 会话和图片

会话键仅为 **`workspaceId + conversationId`**，不同操作者在同一空间会话内共享页面、Cookie、队列和结果，适用于 IM 群聊；每次调用仍由 AI 核心按当前操作者及 Agent 授权。不同会话和空间隔离。

浏览器任务按会话 FIFO 串行，包括操作及自动快照；不同会话和搜索并发。默认空闲 30 分钟回收。达到会话上限优先淘汰没有任务的最久未用会话，无可淘汰资源时报错。排队任务取消后不执行；正在执行的操作取消或超时会关闭上下文。会话删除、插件卸载、浏览器断开使旧标识失效；进程重启不恢复。

工具注册 `resultMode: 'structured'` 后返回 `{ content, images?, isError? }`，普通 JSON 工具不受影响。`ctx.ai.storeToolImage(context, image)` 只接受正在执行的真实工具上下文。图片复用工作空间配额、访问权限、过期规则和聊天附件预览。

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
