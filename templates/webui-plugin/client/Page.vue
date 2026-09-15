<script setup lang="ts">
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <main class="page">
    <h1>新页面</h1>
    <button @click="count++">已点击 {{ count }} 次</button>
  </main>
</template>

<style scoped>
.page {
  padding: 24px;
}
</style>
