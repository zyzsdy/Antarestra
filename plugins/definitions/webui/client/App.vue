<script setup lang="ts">
import { onMounted, onUnmounted, provide } from 'vue'
import { RouterView } from 'vue-router'
import { failures, startExtensions, session, refreshExtensions } from './runtime.js'
import { sessionKey, routerKey, refreshExtensionsKey } from '../src/client.js'
import { router } from './runtime.js'
import FeedbackHost from './FeedbackHost.vue'
let stop: (() => void) | undefined
provide(sessionKey, session)
provide(routerKey, router)
provide(refreshExtensionsKey, () => refreshExtensions())
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
