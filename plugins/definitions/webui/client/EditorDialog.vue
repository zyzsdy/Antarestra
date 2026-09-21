<script setup lang="ts">
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'

defineProps<{ title: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const previous = typeof document === 'undefined' ? null : document.activeElement
function restoreFocus(event: Event) {
  event.preventDefault()
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
}
</script>
<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('close')">
    <DialogPortal disabled>
      <DialogOverlay class="ui-dialog-overlay" />
      <DialogContent
        class="ui-editor-dialog"
        :aria-describedby="undefined"
        @close-auto-focus="restoreFocus"
        @interact-outside.prevent
        @escape-key-down="busy && $event.preventDefault()"
      >
        <header>
          <DialogTitle as="h2">{{ title }}</DialogTitle>
          <button type="button" :disabled="busy" aria-label="关闭弹窗" @click="emit('close')">
            关闭
          </button>
        </header>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
<style>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: #111d3266;
}
.ui-editor-dialog {
  position: fixed;
  z-index: 301;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  width: min(648px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  border: 1px solid #e4e9f1;
  border-radius: 12px;
  padding: 24px;
  background: #fff;
  color: #263047;
}
.ui-editor-dialog > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.ui-editor-dialog > header h2 {
  margin: 0;
}
</style>
