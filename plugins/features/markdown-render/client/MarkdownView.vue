<script setup lang="ts">
import { useMarkdown } from './api.js'
defineProps<{ source: string; streaming?: boolean }>()
const service = useMarkdown()
</script>

<template>
  <component
    v-if="service"
    :is="service.component"
    :source="source"
    :streaming="streaming ?? false"
  />
  <div v-else class="markdown-unavailable" style="white-space: pre-wrap; overflow-wrap: anywhere">
    {{ source }}
  </div>
</template>
