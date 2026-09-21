<script setup lang="ts">
import { PaginationRoot, PaginationPrev, PaginationNext } from 'reka-ui'
defineProps<{ page: number; total: number; pageSize: number; disabled?: boolean; label: string }>()
const emit = defineEmits<{ 'update:page': [page: number] }>()
</script>
<template>
  <PaginationRoot
    :page="page"
    :total="total"
    :items-per-page="pageSize"
    :disabled="disabled"
    :aria-label="label"
    @update:page="emit('update:page', $event)"
  >
    <PaginationPrev aria-label="上一页">上一页</PaginationPrev>
    <span aria-live="polite"
      ><slot>{{ page }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</slot></span
    >
    <PaginationNext aria-label="下一页">下一页</PaginationNext>
  </PaginationRoot>
</template>
