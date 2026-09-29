# Markdown 渲染插件

`@antarestra/plugin-markdown-render` 通过 WebUI 发布浏览器端流式 Markdown 服务，依赖纯功能包 `@antarestra/markdown`。后端只注册客户端资源，DOM 与 Vue 渲染不放进服务端 Cordis 上下文。主配置已在 `chat-webui` 之前启用 `markdown-render: {}`。

服务通过 `markdown-render.service/default` 插槽发布。消费插件在页面包装组件的 `setup` 调用 `provideMarkdown(ctx)`，Vue SFC 使用公开客户端入口的 `MarkdownView`，传入持续增长的 `source` 和 `streaming`。`chat-webui` 的助理正文与思考详情已使用此服务；用户原文仍按纯文本显示。服务未加载或卸载时回退为可读原文，重新加载后恢复渲染。

服务默认支持基础 HTML 与受限内联样式，具体元素、URL 和样式清理规则由 `packages/markdown` 统一维护，详见该包 README。标题使用六级字号，中文斜体在 Markdown 作用域内允许字体合成；插件和聊天页面不重复定义这些样式。

## 注册代码节点扩展

其他插件通过自己的 WebUI 客户端入口注册，函数和 Vue 组件不通过后端 JSON 配置传输。

```typescript
import type { ClientPlugin } from '@antarestra/webui/client'
import { registerCodeRenderer } from '@antarestra/plugin-markdown-render/client'
import JsonCard from './JsonCard.vue'

const apply: ClientPlugin = (ctx) => {
  registerCodeRenderer(ctx, {
    name: 'json-card',
    supportsPartial: false,
    parse: (node) => JSON.parse(node.source),
    component: JsonCard,
  })
}
export default apply
```

模型输出带 `json-card` 名称的围栏代码块时交给此扩展。名字匹配 info 的第一个单词，大小写敏感；后续参数保留在 `node.info`。SFC 接收 `value`（解析结果）与 `node`（`language/info/source/closed`）。

- `supportsPartial: true`：收到完整起始行后，在代码内容增长时调用同步 `parse`，闭合后再调用一次。解析器必须能处理不完整输入。
- `supportsPartial: false`：收到合法结束围栏才调用 `parse`。未闭合、停止或失败的消息显示源码，不调用完整解析器。
- 同一闭合节点不会因后续 token 或消息结束重复解析。Vue 组件实例在更新期间保留，使用 `onUnmounted` 清理副作用。
- 注册绑定传入的 `ClientContext`，返回幂等卸载函数；插件卸载自动回收，同名重复注册明确拒绝，旧卸载函数不能删除新注册。允许在渲染服务尚未加载时先注册。
- 卸载扩展会回收现有组件并恢复普通代码；重载后按当前内容重新渲染。解析异常只影响所在节点，并回退源码。

扩展是可信前端代码，不是安全沙箱。`mermaid` 有内置的完整解析渲染器；显式注册同名扩展可替换它，卸载后恢复内置行为。

## 任意语法节点预留

只导出 `SyntaxExtensionDeclaration`，包含语法声明和 AST 节点类型。未来由主解析器生成 AST 再交给扩展渲染；当前没有注册或执行入口，不宣称支持自定义语法解析。

## 验证

`pnpm test` 包含逐字分片、DOM 引用与 MutationObserver 检查、部分/完整解析、错误隔离、重复注册和卸载恢复用例。可用下列命令打开真实聊天消息组件的本地模拟流页面，验证普通/窄屏布局、复制、扩展卸载和中断；此页面不调用真实模型：

```powershell
pnpm exec vite --host 127.0.0.1 --port 14459 --config tests/fixtures/markdown-preview.config.ts
```

访问 `http://127.0.0.1:14459/tests/fixtures/markdown-preview.html`。
