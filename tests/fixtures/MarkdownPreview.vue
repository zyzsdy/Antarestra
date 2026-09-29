<script setup lang="ts">
import * as vue from 'vue'
import type { ClientContext } from '@antarestra/webui/client'
import type { MessageNode } from '@antarestra/contracts'
import { router, session } from '../../plugins/definitions/webui/client/runtime.js'
import applyMarkdown from '../../plugins/features/markdown-render/client/index.js'
import {
  provideMarkdown,
  registerCodeRenderer,
} from '../../plugins/features/markdown-render/client/api.js'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import { emptyReply } from '../../plugins/features/chat-webui/client/stream.js'
import PreviewValue from './MarkdownPreviewValue.vue'

const slots = new Map<string, Map<string, unknown>>()
const effects: (() => void)[] = []
const ctx: ClientContext = {
  vue,
  router,
  session,
  config: {},
  slot<T>(name: string) {
    if (!slots.has(name)) slots.set(name, vue.shallowReactive(new Map()))
    return slots.get(name)! as ReadonlyMap<string, T>
  },
  contribute(name, id, value) {
    ctx.slot(name)
    const slot = slots.get(name)!
    if (slot.has(id)) throw new Error('重复注册')
    slot.set(id, value)
    const dispose = () => {
      if (slot.get(id) === value) slot.delete(id)
    }
    effects.push(dispose)
    return dispose
  },
  effect(setup) {
    const dispose = setup()
    if (dispose) effects.push(dispose)
  },
  page() {
    return () => {}
  },
}
provideMarkdown(ctx)
applyMarkdown(ctx)
const counts = vue.reactive({ partial: 0, complete: 0 })
let remove: (() => void)[] = []
const registered = vue.ref(false)
function toggle() {
  if (registered.value) remove.splice(0).forEach((dispose) => dispose())
  else
    for (const name of ['partial', 'complete'] as const)
      remove.push(
        registerCodeRenderer(ctx, {
          name,
          supportsPartial: name === 'partial',
          component: PreviewValue,
          parse(node) {
            counts[name]++
            return `${name === 'partial' ? '部分解析' : '完整解析'}：${node.source}`
          },
        }),
      )
  registered.value = !registered.value
}
toggle()
const sample =
  '# 流式 Markdown\n\n已完成的标题与段落在后续输出时保持原节点。\n\n## 常用格式\n\n**加粗**、*斜体*、[外部链接](https://example.com) 和 $E=mc^2$。\n\n- 第一项\n- 第二项\n\n| 功能 | 状态 |\n| --- | --- |\n| 增量渲染 | 已接入 |\n\n```go\nfunc main() { println("hello") }\n```\n\n```partial\n逐步输出的数据\n```\n\n```complete\n只在闭合之后解析\n```\n\n```mermaid\ngraph LR\n A[开始] --> B[完成]\n```\n\n最后一段保持持续追加。'
const reply = vue.reactive(emptyReply())
const node: MessageNode = {
  id: 'preview',
  conversationId: 'preview',
  parentId: null,
  runId: 'preview',
  role: 'assistant',
  content: [],
  createdAt: 0,
  version: 1,
  versionCount: 1,
}
let timer: ReturnType<typeof setInterval> | undefined
function start(incomplete = false) {
  clearInterval(timer)
  const source = incomplete ? '# 中断示例\n\n```complete\n未完成的数据' : sample
  counts.partial = counts.complete = 0
  reply.pending = [{ type: 'text', text: '' }]
  reply.ended = false
  reply.status = '正在回复'
  let length = 0
  timer = setInterval(() => {
    length += 8
    reply.pending = [{ type: 'text', text: source.slice(0, length) }]
    if (length >= source.length) {
      clearInterval(timer)
      reply.ended = true
    }
  }, 70)
}
function stop() {
  clearInterval(timer)
  reply.ended = true
}
vue.onBeforeUnmount(() => {
  clearInterval(timer)
  effects.reverse().forEach((dispose) => dispose())
})
reply.pending = [{ type: 'text', text: sample }]
reply.ended = true
</script>

<template>
  <main class="preview">
    <header>
      <h1>聊天 Markdown 验证</h1>
      <p>本地模拟流，不调用真实模型。使用聊天消息组件和 Markdown 插件服务。</p>
      <div class="actions">
        <button @click="start()">开始流式输出</button>
        <button @click="stop">停止输出</button>
        <button @click="start(true)">未闭合代码块</button>
        <button @click="toggle">{{ registered ? '卸载代码扩展' : '重新注册扩展' }}</button>
      </div>
      <p role="status">部分解析 {{ counts.partial }} 次；完整解析 {{ counts.complete }} 次</p>
    </header>
    <section class="chat-transcript"><ChatMessage :node="node" :live="reply" /></section>
  </main>
</template>

<style scoped>
.preview {
  max-width: 1000px;
  margin: auto;
  padding: 20px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button {
  padding: 8px 12px;
  border: 1px solid #aaa;
  border-radius: 7px;
  background: white;
  cursor: pointer;
}
button:hover {
  background: #f0f0ee;
}
</style>
