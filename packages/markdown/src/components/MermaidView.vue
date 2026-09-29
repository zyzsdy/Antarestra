<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { copyText } from '../clipboard'
import { renderMermaidDiagram } from '../mermaid'

const props = withDefaults(
  defineProps<{
    source: string
    /** 流式生成中：语法尚不完整时显示等待态而不是错误。 */
    streaming?: boolean
  }>(),
  {
    streaming: false,
  },
)

const mode = ref<'diagram' | 'source'>('diagram')
const canvas = ref<HTMLElement | null>(null)
const error = ref('')
const rendering = ref(true)
const copied = ref(false)
const copyError = ref(false)
let active = true

let debounceTimer: number | undefined
let renderSequence = 0
let copiedTimer: number | undefined

async function draw(): Promise<void> {
  const code = props.source.trim()
  if (!code) {
    rendering.value = false
    return
  }
  const current = renderSequence + 1
  renderSequence = current
  rendering.value = true
  try {
    const svg = await renderMermaidDiagram(code)
    if (current !== renderSequence || !canvas.value) return
    canvas.value.innerHTML = svg
    error.value = ''
  } catch (cause) {
    if (current !== renderSequence) return
    error.value = cause instanceof Error ? cause.message : '无法解析图表语法。'
  } finally {
    if (current === renderSequence) rendering.value = false
  }
}

function scheduleDraw(): void {
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void draw()
  }, 240)
}

watch(() => props.source, scheduleDraw, { immediate: true })

async function copySource(): Promise<void> {
  const success = await copyText(props.source)
  if (!active) return
  copied.value = success
  copyError.value = !success
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
    copyError.value = false
  }, 1600)
}

onBeforeUnmount(() => {
  active = false
  window.clearTimeout(debounceTimer)
  window.clearTimeout(copiedTimer)
  renderSequence += 1
})
</script>

<template>
  <div class="md-mermaid-frame">
    <div class="md-code-head md-mermaid-head">
      <span class="md-code-lang">Mermaid</span>
      <div class="md-code-actions">
        <button
          type="button"
          class="md-code-action"
          :aria-label="mode === 'diagram' ? '源代码' : '图表'"
          :title="mode === 'diagram' ? '源代码' : '图表'"
          @click="mode = mode === 'diagram' ? 'source' : 'diagram'"
        >
          <svg
            :key="mode"
            class="md-mode-icon"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path v-if="mode === 'diagram'" d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14"></path>
            <g v-else>
              <rect x="1.8" y="2.5" width="5.4" height="4.2" rx="1"></rect>
              <rect x="8.8" y="2.5" width="5.4" height="4.2" rx="1"></rect>
              <rect x="1.8" y="9.3" width="5.4" height="4.2" rx="1"></rect>
              <path d="M11.5 9.3v4.2M9.4 11.4h4.2"></path>
            </g>
          </svg>
        </button>
        <button
          type="button"
          class="md-code-action"
          :class="{ 'is-copied': copied, 'is-copy-error': copyError }"
          :aria-label="copied ? '已复制' : copyError ? '复制失败，点击重试' : '复制'"
          title="复制"
          @click="copySource"
        >
          <span class="md-action-icon">
            <svg
              class="md-copy-icon"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.6"></rect>
              <path
                d="M10.5 3.4V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.4"
              ></path>
            </svg>
            <svg
              class="md-check-icon"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m3 8 3 3 7-7"></path>
            </svg>
          </span>
          <span class="md-code-label" role="status">{{
            copied ? '已复制' : copyError ? '复制失败' : ''
          }}</span>
        </button>
      </div>
    </div>
    <div v-show="mode === 'diagram'" class="md-mermaid-body">
      <div ref="canvas" class="md-mermaid-canvas"></div>
      <p v-if="error && !streaming" class="md-mermaid-message md-mermaid-message--error">
        图表渲染失败：{{ error }}
        <button type="button" class="md-mermaid-retry" @click="draw">重试</button>
      </p>
      <p v-else-if="(error || rendering) && streaming" class="md-mermaid-message">正在生成图表…</p>
    </div>
    <pre v-if="mode === 'source'" class="md-mermaid-source-view">{{ source }}</pre>
  </div>
</template>
