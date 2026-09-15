<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import type { Session } from './session.js'

const props = defineProps<{
  session: Session | undefined
  failure: string
  signal: AbortSignal
}>()
const feedback = inject(feedbackKey)!
const sidebar = ref(false)
const suggestions = [
  { icon: '✎', title: '写下一个想法', detail: '把零散的灵感整理成文字' },
  { icon: '◎', title: '探索一个问题', detail: '从不同角度看待新的可能' },
  { icon: '⌘', title: '规划下一步', detail: '让想法成为清晰的行动' },
]
async function check() {
  try {
    const response = await fetch('/api/chat-webui/session', {
      cache: 'no-store',
      signal: props.signal,
    })
    if (!response.ok) {
      location.reload()
      return
    }
    const fresh = (await response.json()) as Session
    if (
      fresh.actorId !== props.session?.actorId ||
      fresh.workspaceId !== props.session?.workspaceId
    )
      location.reload()
  } catch {
    /* 下一次聚焦时重新验证；页面没有聊天数据或可执行请求。 */
  }
}
onMounted(() => window.addEventListener('focus', check))
onUnmounted(() => window.removeEventListener('focus', check))
</script>

<template>
  <main v-if="!session" class="chat-error" role="alert">
    <h1>暂时无法进入聊天</h1>
    <p>{{ failure }}</p>
    <a href="/">重试</a>
  </main>
  <div v-else class="chat-app" :class="{ 'sidebar-open': sidebar }">
    <button v-if="sidebar" class="chat-backdrop" aria-label="关闭侧栏" @click="sidebar = false" />
    <aside class="chat-sidebar" aria-label="聊天记录">
      <a class="chat-brand" href="/"><span class="chat-logo">✳</span>Antarestra</a>
      <button class="chat-new" @click="feedback.toast('聊天功能即将开放，敬请期待。')">
        ＋<span>新对话</span>
      </button>
      <div class="chat-history">
        <h2>你的对话</h2>
        <p>还没有聊天记录</p>
        <small>开始一段对话，让想法在这里延续。</small>
      </div>
      <div class="chat-workspace">
        <span>◈</span>
        <div><strong>个人工作空间</strong><small>当前空间暂无对话</small></div>
      </div>
      <a class="chat-profile" :href="session.accountPath">
        <span class="chat-avatar">{{ session.displayName.slice(0, 1) }}</span>
        <div>
          <strong>{{ session.displayName }}</strong>
          <small>{{ session.roles.includes('admin') ? '管理员' : '已登录用户' }}</small>
        </div>
        <span>↗</span>
      </a>
    </aside>
    <main class="chat-main">
      <header class="chat-header">
        <div>
          <button
            class="chat-menu"
            aria-label="打开聊天记录"
            :aria-expanded="sidebar"
            @click="sidebar = !sidebar"
          >
            ☰
          </button>
          <strong>新对话</strong>
        </div>
        <span class="chat-preview">预览版</span>
      </header>
      <section class="chat-welcome">
        <div class="chat-spark">✳</div>
        <p class="chat-eyebrow">让灵感，从一次对话开始</p>
        <h1>今天，有什么新想法？</h1>
        <p class="chat-subtitle">整理思路、探索问题，或是聊聊你的下一个计划。</p>
        <div class="chat-suggestions">
          <button
            v-for="item in suggestions"
            :key="item.title"
            @click="feedback.messagebox('当前为界面预览，暂未接入模型和聊天记录功能。')"
          >
            <span class="suggestion-icon">{{ item.icon }}</span>
            <strong>{{ item.title }}</strong>
            <small>{{ item.detail }}</small>
          </button>
        </div>
      </section>
      <footer class="chat-composer-area">
        <div class="chat-composer">
          <textarea disabled rows="2" placeholder="聊天功能即将开放…" aria-label="消息输入框" />
          <div><span>当前为界面预览</span><button disabled aria-label="发送消息">↑</button></div>
        </div>
        <p>对话将保存在当前工作空间。</p>
      </footer>
    </main>
  </div>
</template>

<style scoped src="./chat.css"></style>
