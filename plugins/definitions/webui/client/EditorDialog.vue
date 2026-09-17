<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
defineProps<{ title: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
let previous: HTMLElement | null = null
onMounted(() => {
  previous = document.activeElement as HTMLElement | null
  dialog.value?.showModal()
})
onUnmounted(() => {
  dialog.value?.close()
  previous?.focus()
})
</script>
<template>
  <dialog
    ref="dialog"
    class="ui-editor-dialog"
    aria-labelledby="ui-editor-title"
    @cancel.prevent="!busy && emit('close')"
  >
    <header>
      <h2 id="ui-editor-title">{{ title }}</h2>
      <button type="button" :disabled="busy" aria-label="关闭弹窗" @click="emit('close')">
        关闭
      </button>
    </header>
    <slot />
  </dialog>
</template>
<style scoped>
.ui-editor-dialog {
  width: min(600px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: auto;
  border: 1px solid #e4e9f1;
  border-radius: 12px;
  padding: 24px;
  color: inherit;
}
.ui-editor-dialog::backdrop {
  background: #111d3266;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
header h2 {
  margin: 0;
}
</style>
