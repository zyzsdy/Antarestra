<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { RouterView } from 'vue-router'
import { failures, startExtensions } from './runtime.js'
import FeedbackHost from './FeedbackHost.vue'
let stop: (() => void) | undefined
onMounted(() => {
  stop = startExtensions()
})
onUnmounted(() => stop?.())
</script>

<template>
  <FeedbackHost>
    <p v-for="failure in failures" :key="failure" role="alert">{{ failure }}</p>
    <RouterView />
  </FeedbackHost>
</template>
