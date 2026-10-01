<script setup lang="ts">
withDefaults(defineProps<{ role?: 'status' | 'alert' }>(), { role: 'status' })
</script>

<template>
  <div class="chat-notice" :role="role"><slot /></div>
</template>

<style scoped>
.chat-notice {
  display: flex;
  box-sizing: border-box;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 auto 12px;
  padding: 6px 12px;
  border-radius: 10px;
  background: #fff7e6;
  color: #79521a;
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  overflow-wrap: anywhere;
}
.chat-notice :deep(.chat-text-button) {
  max-width: 100%;
  color: inherit;
  overflow-wrap: anywhere;
}
.chat-notice :deep(.chat-text-button:hover:not(:disabled)) {
  background: #f8e9c8;
}
</style>
