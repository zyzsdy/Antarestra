<script setup lang="ts">
import { nextTick, onUnmounted, provide, ref } from 'vue'
import { feedbackKey } from '../src/client.js'
const messages = ref<{ id: number; text: string }[]>([])
const dialog = ref<HTMLDialogElement>()
const current = ref<{ title: string; message: string }>()
let sequence = 0
const timers = new Set<ReturnType<typeof setTimeout>>()
const queue: { title: string; message: string; resolve: (value: boolean) => void }[] = []
function notice(text: string) {
  const id = ++sequence
  messages.value.push({ id, text })
  return () => {
    messages.value = messages.value.filter((item) => item.id !== id)
  }
}
async function show() {
  current.value = queue[0]
  if (current.value) {
    await nextTick()
    dialog.value?.showModal()
  }
}
function finish(value: boolean) {
  dialog.value?.close()
  queue.shift()?.resolve(value)
  void show()
}
function modal(title: string, message: string) {
  return new Promise<boolean>((resolve) => {
    queue.push({ title, message, resolve })
    if (queue.length === 1) void show()
  })
}
provide(feedbackKey, {
  notice,
  toast(text) {
    const remove = notice(text)
    const timer = setTimeout(() => {
      remove()
      timers.delete(timer)
    }, 4000)
    timers.add(timer)
    return () => {
      clearTimeout(timer)
      timers.delete(timer)
      remove()
    }
  },
  modal,
  messagebox: (message) => modal('提示', message),
})
onUnmounted(() => {
  for (const timer of timers) clearTimeout(timer)
  for (const item of queue.splice(0)) item.resolve(false)
})
</script>
<template>
  <slot />
  <div class="feedback-messages" aria-live="polite">
    <div v-for="item in messages" :key="item.id" class="feedback-message">
      {{ item.text
      }}<button
        aria-label="关闭通知"
        @click="messages = messages.filter((value) => value.id !== item.id)"
      >
        ×
      </button>
    </div>
  </div>
  <dialog ref="dialog" aria-labelledby="feedback-title" @cancel.prevent="finish(false)">
    <template v-if="current">
      <h2 id="feedback-title">{{ current.title }}</h2>
      <p>{{ current.message }}</p>
      <div class="feedback-actions">
        <button @click="finish(false)">取消</button><button @click="finish(true)">确定</button>
      </div>
    </template>
  </dialog>
</template>
<style scoped>
.feedback-messages {
  position: fixed;
  right: 20px;
  top: 20px;
  z-index: 1000;
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
dialog {
  border: 1px solid #ddd;
  border-radius: 18px;
  max-width: min(480px, calc(100vw - 32px));
  padding: 28px;
  overflow-wrap: anywhere;
}
dialog::backdrop {
  background: #0005;
}
.feedback-actions {
  display: flex;
  justify-content: end;
  gap: 12px;
}
.feedback-actions button {
  padding: 8px 20px;
}
</style>
