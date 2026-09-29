<script setup lang="ts">
import type { CodeNode } from '@antarestra/markdown/core'
defineProps<{ value: string; node: Readonly<CodeNode> }>()
</script>

<template>
  <pre
    class="preview-value">{{ value }}<span>{{ node.closed ? '（已闭合）' : '（生成中）' }}</span></pre>
</template>

<style scoped>
.preview-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #f0f0ee;
  padding: 12px;
  border-radius: 7px;
}
span {
  display: block;
  font-size: 12px;
}
</style>
