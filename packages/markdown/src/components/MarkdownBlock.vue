<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch, createVNode, render } from 'vue'
import { patchMarkdown } from '../dom.js'
import type { CodeNode, CodeRenderer, MarkdownRenderer } from '../types.js'
import MermaidView from './MermaidView.vue'

const props = defineProps<{
  text: string
  streaming: boolean
  renderer: MarkdownRenderer
  extensions: ReadonlyMap<string, CodeRenderer>
}>()
const host = ref<HTMLElement | null>(null)
const mounts = new Map<
  string,
  {
    renderer: CodeRenderer
    node: CodeNode | undefined
    instance: ReturnType<CodeRenderer['mount']> | undefined
    holder: HTMLElement
  }
>()
const mermaid: CodeRenderer = {
  supportsPartial: false,
  mount(holder) {
    return {
      update: (node) => render(createVNode(MermaidView, { source: node.source }), holder),
      dispose: () => render(null, holder),
    }
  },
}
function dispose() {
  for (const entry of mounts.values()) release(entry)
  mounts.clear()
}
function release(entry: { instance: ReturnType<CodeRenderer['mount']> | undefined }) {
  const instance = entry.instance
  entry.instance = undefined
  try {
    instance?.dispose()
  } catch {
    /* 单个扩展清理失败不阻断其他节点。 */
  }
}
function apply() {
  const el = host.value
  if (!el) return
  const nodes = new Map<string, { node: CodeNode; renderer: CodeRenderer }>()
  let index = 0
  const html = props.renderer.render(props.text, {
    streaming: props.streaming,
    fence(node) {
      const key = String(index++)
      const renderer =
        props.extensions.get(node.language) ?? (node.language === 'mermaid' ? mermaid : undefined)
      if (!renderer) return undefined
      nodes.set(key, { node, renderer })
      return `<div data-md-extension="${key}"></div>`
    },
  })
  for (const [key, entry] of mounts) {
    if (nodes.get(key)?.renderer !== entry.renderer) {
      release(entry)
      entry.holder.replaceChildren()
      mounts.delete(key)
    }
  }
  patchMarkdown(el, html)
  for (const [key, { node, renderer }] of nodes) {
    const holder = el.querySelector<HTMLElement>(`[data-md-extension="${key}"]`)!
    let entry = mounts.get(key)
    if (!entry) {
      entry = { renderer, holder, node: undefined, instance: undefined }
      mounts.set(key, entry)
    }
    if (!renderer.supportsPartial && !node.closed) {
      release(entry)
      // 没收到结束围栏时展示源码，但绝不调用扩展解析。
      const preview = document.createElement('pre')
      preview.textContent = node.source
      preview.className = 'md-extension-pending'
      const hint = document.createElement('p')
      hint.textContent = props.streaming ? '等待代码块完成…' : '代码块未闭合，显示源代码。'
      patchMarkdown(holder, preview.outerHTML + hint.outerHTML)
      continue
    }
    if (
      entry.node?.source === node.source &&
      entry.node.closed === node.closed &&
      entry.node.info === node.info
    )
      continue
    entry.node = node
    try {
      if (!entry.instance) {
        holder.replaceChildren()
        entry.instance = renderer.mount(holder)
      }
      entry.instance.update(node)
    } catch {
      release(entry)
      const fallback = document.createElement('pre')
      fallback.textContent = node.source
      const error = document.createElement('p')
      error.textContent = '扩展渲染失败，已显示源代码。'
      holder.replaceChildren(fallback, error)
    }
  }
}
onMounted(apply)
watch(() => [props.text, props.streaming, props.extensions, ...props.extensions.values()], apply)
onBeforeUnmount(dispose)
</script>

<template>
  <div ref="host" class="md-block"></div>
</template>
