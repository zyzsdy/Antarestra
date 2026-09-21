<script setup lang="ts">
import { onUnmounted, provide, ref } from 'vue'
import {
  AlertDialogRoot,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  ToastProvider,
  ToastRoot,
  ToastDescription,
  ToastClose,
  ToastViewport,
} from 'reka-ui'
import { feedbackKey } from '../src/client.js'
import { XMarkIcon } from '../src/icons.js'
const messages = ref<{ id: number; text: string; duration: number }[]>([])
const current = ref<{ id: number; title: string; message: string }>()
let previous: Element | null = null
let sequence = 0
const queue: { id: number; title: string; message: string; resolve: (value: boolean) => void }[] =
  []
function remove(id: number) {
  messages.value = messages.value.filter((item) => item.id !== id)
}
function notice(text: string, duration = Infinity) {
  const id = ++sequence
  messages.value.push({ id, text, duration })
  return () => remove(id)
}
function finish(value: boolean) {
  queue.shift()?.resolve(value)
  current.value = queue[0]
}
function restoreFocus(event: Event) {
  event.preventDefault()
  if (!current.value && previous instanceof HTMLElement && previous.isConnected) previous.focus()
}
function modal(title: string, message: string) {
  return new Promise<boolean>((resolve) => {
    queue.push({ id: ++sequence, title, message, resolve })
    if (queue.length === 1) {
      previous = document.activeElement
      current.value = queue[0]
    }
  })
}
provide(feedbackKey, {
  notice,
  toast: (text) => notice(text, 4000),
  modal,
  messagebox: (message) => modal('提示', message),
})
onUnmounted(() => {
  for (const item of queue.splice(0)) item.resolve(false)
})
</script>
<template>
  <ToastProvider label="通知" :duration="4000">
    <slot />
    <ToastRoot
      v-for="item in messages"
      :key="item.id"
      :duration="item.duration"
      class="feedback-message"
      @update:open="!$event && remove(item.id)"
    >
      <ToastDescription>{{ item.text }}</ToastDescription>
      <ToastClose aria-label="关闭通知"
        ><XMarkIcon class="ui-icon" aria-hidden="true"
      /></ToastClose>
    </ToastRoot>
    <ToastViewport class="feedback-messages" label="通知（F8）" />
  </ToastProvider>
  <AlertDialogRoot v-if="current" :key="current.id" :open="true">
    <AlertDialogPortal>
      <AlertDialogOverlay class="feedback-overlay" />
      <AlertDialogContent
        class="feedback-dialog"
        @close-auto-focus="restoreFocus"
        @escape-key-down.prevent="finish(false)"
      >
        <AlertDialogTitle as="h2">{{ current.title }}</AlertDialogTitle>
        <AlertDialogDescription as="p">{{ current.message }}</AlertDialogDescription>
        <div class="feedback-actions">
          <AlertDialogCancel @click.prevent="finish(false)">取消</AlertDialogCancel>
          <AlertDialogAction class="feedback-confirm" @click.prevent="finish(true)"
            >确定</AlertDialogAction
          >
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
<style scoped>
.feedback-messages {
  position: fixed;
  right: 20px;
  top: 20px;
  z-index: 1000;
  list-style: none;
  margin: 0;
  padding: 0;
  max-width: min(420px, calc(100vw - 40px));
}
.feedback-message {
  padding: 16px;
  margin-bottom: 8px;
  border: 1px solid #ddd;
  border-radius: 12px;
  background: white;
  box-shadow: 0 6px 24px #0001;
  overflow-wrap: anywhere;
}
.feedback-message button {
  margin-left: 16px;
  border: 0;
  background: transparent;
}
.feedback-dialog {
  position: fixed;
  z-index: 501;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  box-sizing: border-box;
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  border: 1px solid #ddd;
  border-radius: 18px;
  max-width: min(480px, calc(100vw - 32px));
  padding: 28px;
  overflow-wrap: anywhere;
}
.feedback-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: #0005;
}
.feedback-actions {
  display: flex;
  justify-content: end;
  gap: 12px;
}
.feedback-actions button {
  min-height: 40px;
  padding: 9px 20px;
  border: 1px solid #d8dee9;
  border-radius: 7px;
  background: #f4f6fa;
  color: #263047;
  font: inherit;
  cursor: pointer;
}
.feedback-actions button:hover {
  background: #e4e9f1;
}
.feedback-actions button:active {
  background: #d8dee9;
}
.feedback-actions .feedback-confirm {
  background: #315ed1;
  border-color: #315ed1;
  color: #fff;
}
.feedback-actions .feedback-confirm:hover {
  background: #244bb0;
}
.feedback-actions .feedback-confirm:active {
  background: #1d3e95;
}
</style>
