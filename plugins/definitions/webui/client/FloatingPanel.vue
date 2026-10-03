<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  DialogRoot,
  DialogTrigger,
  DialogPortal,
  DialogContent,
  DialogTitle,
  DialogClose,
} from 'reka-ui'
import { ArrowsPointingOutIcon, XMarkIcon } from '../src/icons.js'

defineProps<{ title: string }>()
const open = ref(false)
const anchor = ref<HTMLElement>()
const host = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const left = ref(0)
const top = ref(0)
let observer: ResizeObserver | undefined
let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
const viewport = () => ({
  left: window.visualViewport?.offsetLeft ?? 0,
  top: window.visualViewport?.offsetTop ?? 0,
  width: window.visualViewport?.width ?? window.innerWidth,
  height: window.visualViewport?.height ?? window.innerHeight,
})
function move(x: number, y: number) {
  if (!panel.value) return
  const bounds = viewport()
  const owner = host.value?.getBoundingClientRect()
  const style = host.value ? getComputedStyle(host.value) : undefined
  const size = panel.value.getBoundingClientRect()
  left.value =
    Math.max(bounds.left + 12, Math.min(x, bounds.left + bounds.width - size.width - 12)) -
    (owner?.left ?? 0) -
    parseFloat(style?.borderLeftWidth ?? '0')
  top.value =
    Math.max(bounds.top + 12, Math.min(y, bounds.top + bounds.height - size.height - 12)) -
    (owner?.top ?? 0) -
    parseFloat(style?.borderTopWidth ?? '0')
}
function resetPosition() {
  if (!panel.value) return
  const owner = host.value?.getBoundingClientRect() ?? anchor.value?.getBoundingClientRect()
  if (!owner) return
  const width = panel.value.getBoundingClientRect().width
  const bounds = viewport()
  const right = owner.right + 12
  const x =
    right + width <= bounds.left + bounds.width - 12
      ? right
      : owner.left - width - 12 >= bounds.left + 12
        ? owner.left - width - 12
        : bounds.left + bounds.width - width - 12
  move(x, owner.top + 16)
}
function keepVisible() {
  const rect = panel.value?.getBoundingClientRect()
  if (rect) move(rect.left, rect.top)
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || !panel.value) return
  const rect = panel.value.getBoundingClientRect()
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveDrag(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return
  move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y)
}
function stopDrag() {
  drag = undefined
}
function moveWithKeys(event: KeyboardEvent) {
  const rect = panel.value?.getBoundingClientRect()
  if (!rect) return
  const step = event.shiftKey ? 40 : 10
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const offset = offsets[event.key]
  if (offset || event.key === 'Home') {
    event.preventDefault()
    if (offset) move(rect.left + offset[0], rect.top + offset[1])
    else resetPosition()
  }
}
watch(panel, async (value, previous) => {
  if (previous) observer?.unobserve(previous)
  if (!value) return
  await nextTick()
  resetPosition()
  observer?.observe(value)
})
onMounted(() => {
  host.value = anchor.value?.closest<HTMLElement>('.ui-editor-dialog') ?? undefined
  observer = new ResizeObserver(keepVisible)
  if (host.value) observer.observe(host.value)
  window.addEventListener('resize', keepVisible)
  window.visualViewport?.addEventListener('resize', keepVisible)
  window.visualViewport?.addEventListener('scroll', keepVisible)
})
onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', keepVisible)
  window.visualViewport?.removeEventListener('resize', keepVisible)
  window.visualViewport?.removeEventListener('scroll', keepVisible)
})
</script>

<template>
  <span ref="anchor">
    <DialogRoot v-model:open="open" :modal="false">
      <DialogTrigger as-child><slot name="trigger" /></DialogTrigger>
      <DialogPortal :to="host ?? 'body'">
        <DialogContent as-child :aria-describedby="undefined" @interact-outside.prevent>
          <section
            ref="panel"
            class="ui-floating-panel"
            :style="{ left: `${left}px`, top: `${top}px`, position: host ? 'absolute' : 'fixed' }"
          >
            <header class="ui-floating-panel-header">
              <DialogTitle as-child>
                <button
                  type="button"
                  class="ui-floating-panel-handle"
                  :aria-label="`${title}，拖动或使用方向键移动，Home 复位`"
                  title="拖动或使用方向键移动，Home 复位"
                  @pointerdown="startDrag"
                  @pointermove="moveDrag"
                  @pointerup="stopDrag"
                  @pointercancel="stopDrag"
                  @lostpointercapture="stopDrag"
                  @keydown="moveWithKeys"
                >
                  <ArrowsPointingOutIcon class="ui-icon" aria-hidden="true" />{{ title }}
                </button>
              </DialogTitle>
              <DialogClose
                type="button"
                class="ui-floating-panel-close"
                :aria-label="`关闭${title}`"
                :title="`关闭${title}`"
              >
                <XMarkIcon class="ui-icon" aria-hidden="true" />
              </DialogClose>
            </header>
            <div class="ui-floating-panel-body"><slot v-if="open" /></div>
          </section>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </span>
</template>

<style scoped>
.ui-floating-panel {
  z-index: 1;
  box-sizing: border-box;
  width: min(340px, calc(100vw - 24px));
  max-height: calc(100dvh - 24px);
  display: flex;
  flex-direction: column;
  border: 1px solid #ccd4e1;
  border-radius: 12px;
  background: #fff;
  color: #263047;
  box-shadow: 0 12px 36px #111d3226;
}
.ui-floating-panel-header {
  display: flex;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid #e4e9f1;
}
.ui-floating-panel button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px;
  min-height: 36px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ui-floating-panel button:hover {
  background: #edf2ff;
}
.ui-floating-panel button:active {
  background: #dfe8fb;
}
.ui-floating-panel .ui-floating-panel-handle {
  flex: 1;
  justify-content: flex-start;
  cursor: grab;
  touch-action: none;
  user-select: none;
  font-weight: 600;
  white-space: normal;
  text-align: left;
}
.ui-floating-panel .ui-floating-panel-handle:active {
  cursor: grabbing;
}
.ui-floating-panel-close {
  flex-shrink: 0;
}
.ui-floating-panel-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
  overflow-wrap: anywhere;
  line-height: 1.6;
  font-size: 13px;
}
</style>
