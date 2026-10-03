# 日志输出器

此插件为 Cordis 4 原生 logger 注册终端和文件输出器，不提供新的 logger 服务。其他插件仅依赖 `@antarestra/plugin-sdk`，直接使用 `ctx.logger.debug/info/warn/error`，不需要 `inject: ['logger']`。

```typescript
import type { Context } from '@antarestra/plugin-sdk'

export function apply(ctx: Context) {
  ctx.logger.info('插件已启动')
  ctx.logger.debug('当前计数：%d', 3)
  ctx.logger.error(new Error('操作失败'))
}
```

默认由 Cordis 自动提供所属插件名；需要明确名称时使用 `ctx.logger('server')`。没有独立的 section 参数，标签直接写入正文，例如 `ctx.logger('server').info('[http-req] %s %s %d', 'GET', '/api/health', 200)`。

```text
[info] 2026-09-11 12:31:35 [server] [http-req] GET /api/health 200
```

时间使用消息产生时的本地时间，显示到秒。支持 Cordis 格式化、Error 和多行正文，每行补齐前缀。文件为无 ANSI 颜色的 UTF-8 文本。终端时间显示为灰色，等级标签使用柔和配色：debug 为紫色、info 为蓝色、warn 为黄色、error 为红色。等级颜色只作用于方括号标签，插件名称保留独立配色，正文保持终端默认颜色。

## 配置

在主配置中先加载日志输出器，再加载需要输出日志的插件：

```yaml
plugins:
  plugin-logger:
    console: true
    consoleLevel: info
    file: false
    fileLevel: debug
    directory: ../../log
    rotation: daily
    retentionDays: 30
    maxSize: 104857600
  plugin-server: {}
```

以上即所有默认值。日志等级按 `debug < info < warn < error` 排序，终端和文件分别设置最低输出等级。非法类型、等级、轮转模式、空目录和非正安全整数阈值会拒绝启动。

`directory` 相对于进程工作目录，不是主配置目录或插件目录。使用根目录 `pnpm start` / `pnpm dev` 时，服务端工作目录为 `apps/server`，默认目录对应仓库根目录的 `log`；直接从仓库根目录运行 Node 时，默认目录会位于仓库外两级。可配置绝对路径以避免启动目录差异。文件输出关闭时不创建目录。

| 轮转模式 | 文件名                              | 行为                                         |
| -------- | ----------------------------------- | -------------------------------------------- |
| `none`   | `antarestra.log`                    | 一直追加，不自动删除                         |
| `daily`  | `antarestra-YYYY-MM-DD.log`         | 每天分文件，默认保留今天和此前 29 个本地日期 |
| `size`   | `antarestra-size-000000.log` 起递增 | 默认每 100 MiB 切换，不自动删除历史          |

`retentionDays` 只影响 `daily`；启动和跨日首次写入时清理过期文件，无日志期间不启动清理定时器。只清理匹配有效日期名称的普通日志文件，不处理其他文件、目录或符号链接。

`maxSize` 单位是字节，只影响 `size`。按实际 UTF-8 字节数在写入前判断；超过阈值的单条日志完整写入独立文件，不拆分。重启会追加已有日志并恢复文件大小。同一进程内，文件输出器不能同时使用同一个规范化目录；不同进程应使用不同目录。

## 颜色与生命周期

真彩色和 256 色分别内置 216 种不同颜色，柔和、低至中等饱和度、中等明度的颜色优先。按实际输出流能力选择真彩色、256 色或 16 色；重定向、无颜色能力或设置 `NO_COLOR` 时输出纯文本。不会查询终端背景或读取标准输入。

插件首次出现时按顺序分配颜色，同名插件在该输出器生命周期内保持一致，用尽后循环。不同主题、字体及显示器仍会影响可读性；颜色用于辅助辨认，插件名始终保留。

所有终端日志写入标准输出。文件写入按顺序异步排队，卸载时注销输出器、排空队列并关闭文件。优雅关闭可等待清理，强制结束进程不保证队列全部落盘。文件运行故障会停止该文件输出，向标准错误输出一次诊断，终端输出继续；清理时报告失败。不通过 logger 输出故障诊断，以免递归。

未加载或卸载本插件时，不产生本插件的终端与文件输出。保留 Cordis 自带的内部内存缓冲，但注册输出器时不回放历史消息。

server 会记录监听地址、最终请求状态、请求异常和提前断开，不主动记录查询参数、请求头和请求体。调用方仍需避免把密钥、令牌或其他敏感数据放进日志正文及异常文本。
