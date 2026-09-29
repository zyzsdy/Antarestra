# Markdown 功能包

从 `Antarestra-old/packages/markdown` 迁入，保留 Markdown、语法高亮、KaTeX、任务列表、表格、复制和懒加载 Mermaid。这个包不依赖 Cordis、Plugin SDK 或 WebUI，也不负责插件注册。

`@antarestra/markdown/core` 提供 `createMarkdownRenderer`、`createMarkdownStream` 与节点契约，可独立解析 Markdown，使用 TypeScript 构建到 `dist`；默认入口额外提供 Vue 的 `MarkdownContent` 和样式。Vue 源码由使用它的 Vite 项目构建，包自身通过 `vue-tsc` 校验。

```vue
<script setup lang="ts">
import { MarkdownContent } from '@antarestra/markdown'
defineProps<{ text: string; running: boolean }>()
</script>

<template>
  <MarkdownContent :source="text" :streaming="running" />
</template>
```

每条消息有独立增量会话。持续追加时只重新解析最后一个未稳定的顶层 AST 块；已稳定块保留对象、组件和 DOM。活动块通过 DOM 差异更新保留未变化元素与文本节点，不使用整块 `innerHTML` 替换。未闭合行内语法仍可能在补全后改变节点类型，这是语法完成带来的必要变更。源码被修改或替换时重新建立分块，不能把历史编辑当成追加。

代码扩展通过 `extensions: ReadonlyMap<string, CodeRenderer>` 传入，每个代码节点有自己的 `mount/update/dispose` 实例；完成后不因后续文本追加重复更新。扩展异常显示源码，卸载扩展恢复普通代码。Mermaid 默认等待围栏闭合后绘制，未闭合时保留源码。

`closed` 根据 Markdown AST 判断合法结束围栏，兼容长围栏、波浪号围栏、引用和列表嵌套。流式末尾没有换行的结束围栏要等下一次换行或消息结束才确认，避免下一分片把它变成普通代码行。消息结束不会补造缺失的结束围栏。

原始 HTML 默认关闭；写入 DOM 的普通渲染结果统一经 DOMPurify 清洗。`render()` 返回未清洗 HTML，直接使用字符串 API 时调用方仍需清洗。可信扩展负责自己的渲染和副作用清理。当前引用式链接按块解析，后续块的引用定义不会回写已稳定块；需要跨块链接时使用行内链接。
