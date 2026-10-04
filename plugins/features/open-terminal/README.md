# 远端终端工具

`open-terminal` 通过一个 [open-webui/open-terminal](https://github.com/open-webui/open-terminal) 服务，向 AI 注册全局固定的 `bash`、`read`、`write`、`edit` 四个工具。工具参数参考 [pi 0.99.1](https://github.com/badlogic/pi-mono/tree/v0.99.1/packages/coding-agent/src/core/tools)。已使用 Open Terminal 0.14.0 官方 `slim` 容器验证。

## 配置

在主配置的 `plugins` 下添加：

```yaml
plugins:
  http: {}
  open-terminal:
    url: $OPEN_TERMINAL_URL
    apiKey: $OPEN_TERMINAL_API_KEY
```

`url` 是远端服务的 HTTP(S) 根地址，例如 `http://127.0.0.1:8000`，也支持反向代理路径前缀。`apiKey` 使用环境变量引用，配置面板按密码字段显示。插件还依赖已有的 `ai` 服务。无需启动 Open WebUI，也不使用 MCP 接口。

插件只允许配置一个实例，四个工具都使用同一地址、Bearer 密钥和固定的 `X-Session-Id: antarestra-open-terminal`，不发送用户或工作空间标识。**所有获准调用这些工具的助理都能访问同一远端环境和文件，不提供工作空间隔离。** 助理仍需在工具列表中启用相应名称，或使用项目的默认全工具策略。

远端需要 Linux/POSIX 环境、`bash` 和 `python3`；官方默认和 `slim` 镜像提供这些运行条件。命令和文件操作都在远端执行，Antarestra 不执行本地 Shell、不读取或改写本地路径。相对路径从远端服务的工作目录解析；推荐跨工具使用绝对路径。每次 `bash` 启动独立进程，`cd`、`export` 不跨调用保留。

## 工具参数

| 工具    | 参数                                        | 行为                                                                                                                                         |
| ------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`  | `command`，可选 `timeout`（秒，最多 86400） | 运行 Bash，等待结束，返回合并输出、退出码和截断状态。不传 `timeout` 时不设置命令执行时限。非零退出码作为工具错误。                           |
| `read`  | `path`，可选 `offset`、`limit`              | `offset` 从 1 开始。文本最多返回 2000 行或 50 KiB，并提示下一次读取位置。支持最多 8 MiB 的 PNG/JPEG/GIF/WebP 图片。                          |
| `write` | `path`、`content`                           | 写入完整 UTF-8 文本，覆盖已有内容并自动创建父目录。                                                                                          |
| `edit`  | `path`、`edits: [{ oldText, newText }]`     | 所有替换针对原文件匹配，拒绝空匹配、缺失、歧义、重叠和无变化修改，全部校验通过后写入。也支持单次 `oldText`、`newText`，不能与 `edits` 混用。 |

`edit` 在远端执行 Python 脚本，使用文件锁、保留 UTF-8 BOM，按原文件的 LF/CRLF 风格写入并返回差异。路径和修改内容通过 Base64 JSON 传递，不作为 Shell/Python 源码拼接。不执行 pi 的模糊匹配。原生 `/files/replace` 按顺序替换，因此未使用它实现 pi 的多处原文件匹配契约。

`read`、`write` 使用原生 `/files/read`、`/files/write`；`bash`、`edit` 使用 `/execute` 及状态、终止接口。插件内所有调用串行执行，避免自身并发文件修改相互覆盖。文件写入不会自动重试。读取图片时复用 AI 附件服务，将图片保存在发起调用的会话所属空间；远端文件本身仍然共享。没有可用的附件存储服务时，图片读取会明确失败，文本读取不受影响。

## 输出和生命周期

`bash` 输出不超过 200 行时完整返回；超过 200 行时只返回前 100 行和后 100 行，最多返回 200 行命令内容，中间插入：

```text
因输出太长已截断。只保留前100行和后100行，若需读取完整内容，请使用 `read` 读取 /tmp/antarestra-bash-实际唯一标识.log
```

完整 stdout/stderr 直接合并写入远端 `/tmp/antarestra-bash-*.log`，返回结果的 `outputPath` 是实际文件地址。使用 `read` 的 `path`、`offset`、`limit` 分段读取，不需要 ID 查询。输出文件独立于 Open Terminal 的进程日志，不受其日志轮转影响；插件重载后仍可读取，直到远端文件被清理或容器被删除。插件不会自动删除这些输出文件。

为防止超长单行撑满上下文，返回的两端片段另设 48 KiB 内容预算，按行裁剪并明确提示，完整文件保留原始字节。`edit` 差异仍限制为末尾 2000 行或 50 KiB。单个 HTTP 响应最多 12 MiB；每次 HTTP 请求最多等待 30 秒，与 Bash 的整体执行时限分别计算。

取消调用、执行超时、插件卸载及 AI/HTTP 依赖卸载时，插件会通过远端进程 ID 请求强制终止并等待清理，之后关闭自己的连接池。创建进程的请求先等待 ID 返回，再处理取消，避免遗失已创建进程。网络中断使创建结果未知或终止请求失败时，无法保证对端停止；插件不重复执行命令，清理失败会记录进程 ID。已完成的文件写入不会因取消自动回滚。

## 验证

默认执行协议、认证、分页、参数、错误处理及 Cordis 生命周期测试：

```powershell
pnpm exec vitest run tests/integration/open-terminal.test.ts --maxWorkers=1
```

使用一个专门用于测试的 Open Terminal 实例，可额外运行真实远端测试。测试在远端 `/tmp/antarestra-*` 写入临时文件，建议使用可丢弃容器：

```powershell
$env:OPEN_TERMINAL_TEST_URL = 'http://127.0.0.1:8000'
$env:OPEN_TERMINAL_TEST_API_KEY = '测试实例密钥'
pnpm exec vitest run tests/integration/open-terminal.test.ts --maxWorkers=1
```

这些测试验证真实终端 API 和文件/进程行为，不依赖模型密钥，也不代表真实模型端到端测试。
