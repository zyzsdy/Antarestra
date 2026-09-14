<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { failures, pages, startExtensions } from './runtime.js'
const path = ref(location.pathname.replace(/\/?$/, '/'))
const current = computed(() => pages.get(path.value))
function navigate(event: MouseEvent, target: string) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  history.pushState(null, '', target)
  path.value = target
}
const popstate = () => {
  path.value = location.pathname.replace(/\/?$/, '/')
}
let stop: (() => void) | undefined
onMounted(() => {
  window.addEventListener('popstate', popstate)
  stop = startExtensions()
})
onUnmounted(() => {
  window.removeEventListener('popstate', popstate)
  stop?.()
})
</script>

<template>
  <div class="shell">
    <header class="shell-header">
      <a class="shell-brand" href="/" @click="navigate($event, '/')">✳ Antarestra</a>
      <nav aria-label="主导航">
        <a href="/" :aria-current="path === '/' ? 'page' : undefined" @click="navigate($event, '/')"
          >首页</a
        >
        <a
          v-for="page in pages.values()"
          :key="page.path"
          :href="page.path"
          :aria-current="path === page.path ? 'page' : undefined"
          @click="navigate($event, page.path)"
          >{{ page.name }}</a
        >
      </nav>
    </header>
    <p v-for="failure in failures" :key="failure" class="shell-message" role="status">
      {{ failure }}
    </p>
    <component :is="current.component" v-if="current" :key="current.path" />
    <main v-else class="shell-home">
      <p class="eyebrow">开放组合 · 独立演进</p>
      <h1>{{ path === '/' ? '一个空间，无限种可能。' : '页面暂不可用' }}</h1>
      <p>
        {{
          path === '/'
            ? '欢迎来到 Antarestra。选择一个页面，开始使用。'
            : '页面可能尚未加载或已经停用，请从导航选择其他页面。'
        }}
      </p>
      <div class="shell-cards">
        <a
          v-for="page in pages.values()"
          :key="page.path"
          :href="page.path"
          @click="navigate($event, page.path)"
          ><strong>{{ page.name }}</strong
          ><span>打开页面 →</span></a
        >
      </div>
    </main>
  </div>
</template>
