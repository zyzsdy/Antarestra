<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import MarkdownBlock from './MarkdownBlock.vue'
import { copyText } from '../clipboard.js'
import { createMarkdownRenderer } from '../markdown.js'
import { createMarkdownStream } from '../stream.js'
import type { CodeRenderer } from '../types.js'

const props = withDefaults(
  defineProps<{
    source: string
    streaming?: boolean
    codeWrap?: boolean
    html?: boolean
    linkify?: boolean
    highlight?: boolean
    math?: boolean
    tasklist?: boolean
    extensions?: ReadonlyMap<string, CodeRenderer>
  }>(),
  {
    streaming: false,
    codeWrap: false,
    html: true,
    linkify: true,
    highlight: true,
    math: true,
    tasklist: true,
    extensions: () => new Map(),
  },
)
const renderer = createMarkdownRenderer({
  html: props.html,
  linkify: props.linkify,
  highlight: props.highlight,
  math: props.math,
  tasklist: props.tasklist,
})
const stream = createMarkdownStream(renderer)
const blocks = computed(() => stream.update(props.source, props.streaming))
const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
let active = true
async function handleClick(event: Event) {
  const target = event.target instanceof Element ? event.target : null
  const button = target?.closest<HTMLButtonElement>('.md-code-copy')
  if (!button) return
  const code = button.closest('.md-code')?.querySelector('pre code')?.textContent ?? ''
  const copied = await copyText(code)
  if (!active || !button.isConnected) return
  const label = button.querySelector('.md-code-label')
  clearTimeout(timers.get(button))
  button.classList.toggle('is-copied', copied)
  button.classList.toggle('is-copy-error', !copied)
  button.setAttribute('aria-label', copied ? '已复制' : '复制失败，点击重试')
  if (label) label.textContent = copied ? '已复制' : '复制失败'
  const timer = setTimeout(() => {
    timers.delete(button)
    button.classList.remove('is-copied', 'is-copy-error')
    button.setAttribute('aria-label', '复制')
    if (label) label.textContent = ''
  }, 1600)
  timers.set(button, timer)
}
onBeforeUnmount(() => {
  active = false
  for (const timer of timers.values()) clearTimeout(timer)
})
</script>

<template>
  <div class="md-body" :class="{ 'md-body--code-wrap': codeWrap }" @click="handleClick">
    <MarkdownBlock
      v-for="block in blocks"
      :key="block.id"
      :text="block.source"
      :streaming="block.streaming"
      :renderer="renderer"
      :extensions="extensions"
    />
  </div>
</template>
