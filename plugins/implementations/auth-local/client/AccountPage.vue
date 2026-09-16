<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from './api.js'
const props = defineProps<{ base: string; allowRegistration: boolean }>()
const { api, run, message, busy } = useApi()
const account = ref<{ principal: { display_name: string }; auth: { principalId: string } }>()
const mode = ref('login')
const email = ref('')
const password = ref('')
const displayName = ref('')
const loading = ref(true)
onMounted(async () => {
  try {
    account.value = await api('/auth/me')
  } catch {
    /* 未登录时显示登录表单。 */
  } finally {
    loading.value = false
  }
})
function submit() {
  void run(async () => {
    await api(props.base + '/' + mode.value, {
      email: email.value,
      password: password.value,
      displayName: displayName.value,
    })
    password.value = ''
    if (mode.value === 'register') {
      mode.value = 'login'
      message.value = '账号创建成功，请登录。'
      return
    }
    const target = new URLSearchParams(location.search).get('returnTo')
    if (target === '/' || (target && /^\/admin(?:\/[a-z0-9-]+)*\/?$/i.test(target))) {
      location.assign(target)
      return
    }
    account.value = await api('/auth/me')
  })
}
function logout() {
  void run(async () => {
    await api('/auth/logout', {})
    account.value = undefined
    message.value = '已退出登录'
  })
}
</script>
<template>
  <main class="auth-account auth-ui">
    <p class="eyebrow">ANTARESTRA / ACCOUNT</p>
    <h1>从你的账号开始。</h1>
    <p class="muted">登录 Antarestra，访问你的工作空间。</p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="loading">正在加载账号…</p>
    <section v-else-if="account" class="panel">
      <h2>{{ account.principal.display_name }}</h2>
      <p class="muted">主体：{{ account.auth.principalId }}</p>
      <div class="actions">
        <a href="/">进入聊天</a><a href="/admin/">管理控制台</a
        ><button :disabled="busy" @click="logout">退出登录</button>
      </div>
    </section>
    <section v-else class="panel">
      <nav class="actions">
        <button :class="{ primary: mode === 'login' }" @click="mode = 'login'">登录</button
        ><button
          v-if="allowRegistration"
          :class="{ primary: mode === 'register' }"
          @click="mode = 'register'"
        >
          创建账号
        </button>
      </nav>
      <form @submit.prevent="submit">
        <h2>{{ mode === 'login' ? '欢迎回来' : '创建你的账号' }}</h2>
        <label v-if="mode === 'register'"
          >显示名称<input
            v-model="displayName"
            autocomplete="nickname"
            required
            maxlength="128" /></label
        ><label
          >邮箱<input
            v-model="email"
            type="email"
            autocomplete="username"
            required
            maxlength="254" /></label
        ><label
          >密码<input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            required
            minlength="8"
            maxlength="128" /></label
        ><button class="primary" :disabled="busy">
          {{ busy ? '处理中…' : mode === 'login' ? '登录' : '创建账号' }}
        </button>
      </form>
    </section>
  </main>
</template>
<style scoped>
.auth-account {
  max-width: 640px;
  margin: 9vh auto;
  padding: 24px;
}
.eyebrow {
  font-size: 11px;
  letter-spacing: 2px;
  color: #687fa7;
}
h1 {
  font-size: 32px;
}
</style>
