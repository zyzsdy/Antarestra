<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@antarestra/webui/components'
import {
  XMarkIcon,
  PlusIcon,
  MinusIcon,
  ArrowPathIcon,
  ArrowDownTrayIcon,
} from '@antarestra/webui/icons'

const props = defineProps<{
  src: string
  name: string
  download?: string
  loading?: boolean
  error?: string
}>()
const emit = defineEmits<{ close: []; retry: [] }>()
const previous = document.activeElement
const stage = ref<HTMLElement>()
const scale = ref(1)
const x = ref(0)
const y = ref(0)
const loaded = ref(false)
const failed = ref(false)
const ready = computed(() => loaded.value && !failed.value && !props.loading && !props.error)
const attempt = ref(0)
const dragging = ref(false)
let pointer: { id: number; x: number; y: number } | undefined
const transform = computed(() => `translate(${x.value}px, ${y.value}px) scale(${scale.value})`)
function reset() {
  scale.value = 1
  x.value = y.value = 0
}
function zoom(factor: number, clientX?: number, clientY?: number) {
  if (!ready.value) return
  const next = Math.min(8, Math.max(0.25, scale.value * factor))
  const rect = stage.value?.getBoundingClientRect()
  const px = rect && clientX !== undefined ? clientX - rect.left - rect.width / 2 : 0
  const py = rect && clientY !== undefined ? clientY - rect.top - rect.height / 2 : 0
  x.value = px - (px - x.value) * (next / scale.value)
  y.value = py - (py - y.value) * (next / scale.value)
  scale.value = next
}
function wheel(event: WheelEvent) {
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 300 : 1)
  zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), event.clientX, event.clientY)
}
function start(event: PointerEvent) {
  if (!ready.value || event.button !== 0 || pointer) return
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
  dragging.value = true
  stage.value?.setPointerCapture(event.pointerId)
  stage.value?.focus()
}
function move(event: PointerEvent) {
  if (pointer?.id !== event.pointerId) return
  x.value += event.clientX - pointer.x
  y.value += event.clientY - pointer.y
  pointer.x = event.clientX
  pointer.y = event.clientY
}
function end(event: PointerEvent) {
  if (pointer?.id !== event.pointerId) return
  pointer = undefined
  dragging.value = false
  if (stage.value?.hasPointerCapture(event.pointerId))
    stage.value.releasePointerCapture(event.pointerId)
}
function keydown(event: KeyboardEvent) {
  if (!ready.value) return
  const distance = event.shiftKey ? 80 : 32
  switch (event.key) {
    case 'ArrowLeft':
      x.value -= distance
      break
    case 'ArrowRight':
      x.value += distance
      break
    case 'ArrowUp':
      y.value -= distance
      break
    case 'ArrowDown':
      y.value += distance
      break
    case '+':
    case '=':
      zoom(1.25)
      break
    case '-':
      zoom(0.8)
      break
    case 'Home':
    case '0':
      reset()
      break
    default:
      return
  }
  event.preventDefault()
}
function imageError() {
  failed.value = true
  loaded.value = false
}
function retry() {
  failed.value = loaded.value = false
  reset()
  attempt.value++
  emit('retry')
}
function restoreFocus(event: Event) {
  event.preventDefault()
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && emit('close')">
    <DialogPortal>
      <DialogOverlay class="chat-image-overlay" />
      <DialogContent class="chat-image-preview" @close-auto-focus="restoreFocus">
        <header class="chat-image-header">
          <DialogTitle class="chat-image-title">{{ name || '图片预览' }}</DialogTitle>
          <DialogClose class="chat-image-control" aria-label="关闭图片预览" title="关闭图片预览">
            <XMarkIcon class="ui-icon" />
          </DialogClose>
        </header>
        <div
          ref="stage"
          class="chat-image-stage"
          :class="{ 'is-dragging': dragging, 'is-ready': ready }"
          tabindex="0"
          role="group"
          aria-label="图片查看区域，方向键移动，加减键缩放，Home 复位"
          @wheel.prevent="wheel"
          @pointerdown="start"
          @pointermove="move"
          @pointerup="end"
          @pointercancel="end"
          @lostpointercapture="end"
          @keydown="keydown"
        >
          <p v-if="error || failed" class="chat-image-state" role="alert">
            {{ error || '图片加载失败，请检查网络或文件是否已过期。' }}
            <button type="button" class="chat-image-control" @click="retry">重试</button>
          </p>
          <p v-else-if="loading || !loaded" class="chat-image-state" role="status">正在加载图片…</p>
          <img
            v-if="!failed && !error && !loading"
            :key="attempt"
            :src="props.src"
            :alt="name"
            :style="{ transform, visibility: ready ? 'visible' : 'hidden' }"
            draggable="false"
            @load="loaded = true"
            @error="imageError"
            @dragstart.prevent
          />
        </div>
        <footer class="chat-image-footer">
          <div class="chat-image-tools" aria-label="图片预览操作">
            <button
              type="button"
              class="chat-image-control"
              aria-label="缩小图片"
              title="缩小图片"
              :disabled="!ready || scale <= 0.25"
              @click="zoom(0.8)"
            >
              <MinusIcon class="ui-icon" />
            </button>
            <output class="chat-image-scale" aria-label="相对初始尺寸的缩放比例"
              >{{ Math.round(scale * 100) }}%</output
            >
            <button
              type="button"
              class="chat-image-control"
              aria-label="放大图片"
              title="放大图片"
              :disabled="!ready || scale >= 8"
              @click="zoom(1.25)"
            >
              <PlusIcon class="ui-icon" />
            </button>
            <button
              type="button"
              class="chat-image-control"
              aria-label="复位图片"
              title="复位图片"
              :disabled="!ready"
              @click="reset"
            >
              <ArrowPathIcon class="ui-icon" />
            </button>
            <a
              v-if="download && !loading && !error"
              class="chat-image-control"
              :href="download"
              aria-label="下载图片"
              title="下载图片"
              ><ArrowDownTrayIcon class="ui-icon"
            /></a>
          </div>
          <DialogDescription class="chat-image-hint"
            >滚轮缩放 · 拖动或方向键移动 · Esc 关闭</DialogDescription
          >
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.chat-image-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: #111d32d9;
}
.chat-image-preview {
  position: fixed;
  inset: 16px;
  z-index: 301;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #dededb;
  border-radius: 12px;
  background: #fff;
  color: #28292c;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.chat-image-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  flex: none;
}
.chat-image-title {
  margin: 0;
  font-size: 16px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-image-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #f0f0ee;
  touch-action: none;
  user-select: none;
}
.chat-image-stage.is-ready {
  cursor: grab;
}
.chat-image-stage.is-dragging {
  cursor: grabbing;
}
.chat-image-stage img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  flex: none;
  transform-origin: center;
  pointer-events: none;
}
.chat-image-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 24px;
  text-align: center;
}
.chat-image-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  flex: none;
}
.chat-image-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}
.chat-image-control {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 40px;
  height: 40px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-decoration: none;
}
.chat-image-control:hover:not(:disabled) {
  background: #eaeae7;
}
.chat-image-control:active:not(:disabled) {
  background: #dededb;
}
.chat-image-control:disabled {
  opacity: 0.4;
  cursor: default;
}
.chat-image-preview :focus-visible {
  outline: 2px solid var(--focus-ring, #315ed1);
  outline-offset: -2px;
}
.chat-image-scale {
  min-width: 48px;
  text-align: center;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.chat-image-hint {
  margin: 0;
  font-size: 12px;
  color: #585954;
  text-align: center;
}
@media (max-width: 760px) {
  .chat-image-preview {
    inset: 8px;
  }
}
</style>
