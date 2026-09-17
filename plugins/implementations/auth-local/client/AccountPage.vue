<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from './api.js'
import { AntarestraLogo } from '@antarestra/webui/components'
import type { SessionSnapshot } from '@antarestra/webui/client'
import PasswordField from './PasswordField.vue'
const props = defineProps<{
  base: string
  allowRegistration: boolean
  changePasswordPath: string
}>()
const { api, run, message, busy, session, router } = useApi()
const account = ref<{
  principal: { display_name: string }
  auth: { principalId: string }
  session: SessionSnapshot
}>()
const mode = ref<'login' | 'register'>('login')
const loginName = ref('')
const password = ref('')
const confirmPassword = ref('')
const displayName = ref('')
const loading = ref(true)
const form = ref<HTMLFormElement>()
const invalid = ref('')
function setMode(next: 'login' | 'register') {
  mode.value = next
  invalid.value = ''
  message.value = ''
}
function moveTab(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = Array.from(
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    ) ?? [],
  )
  if (!tabs.length) return
  event.preventDefault()
  const current = tabs.indexOf(event.currentTarget as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}
onMounted(async () => {
  try {
    account.value = await api('/auth/me')
    const local = await api<{ passwordChangeRequired: boolean }>(props.base + '/account')
    account.value!.session.passwordChangeRequired = local.passwordChangeRequired
    session.set(account.value!.session)
    if (local.passwordChangeRequired) {
      void router.replace(props.changePasswordPath)
      return
    }
    const returnTo = router.currentRoute.value.query.returnTo
    if (
      typeof returnTo === 'string' &&
      (returnTo === '/' || /^\/admin(?:\/[a-z0-9-]+)*\/?$/i.test(returnTo))
    )
      void router.replace(returnTo)
  } catch {
    /* 未登录时显示登录表单。 */
  } finally {
    loading.value = false
  }
})
function submit() {
  void run(async () => {
    invalid.value =
      mode.value === 'register' && !displayName.value.trim()
        ? 'displayName'
        : !loginName.value.trim() || /\s/.test(loginName.value)
          ? 'loginName'
          : password.value.length < 8 || password.value.length > 128
            ? 'password'
            : mode.value === 'register' && password.value !== confirmPassword.value
              ? 'confirmPassword'
              : ''
    if (invalid.value) {
      form.value?.querySelector<HTMLInputElement>(`[name="${invalid.value}"]`)?.focus()
      throw new Error(
        invalid.value === 'displayName'
          ? '请填写显示名称。'
          : invalid.value === 'loginName'
            ? '请填写不含空白的登录名。'
            : invalid.value === 'confirmPassword'
              ? '两次输入的密码不一致。'
              : '密码长度必须为 8–128 位。',
      )
    }
    const result = await api<{ session?: SessionSnapshot }>(props.base + '/' + mode.value, {
      loginName: loginName.value,
      password: password.value,
      displayName: displayName.value,
    })
    password.value = ''
    confirmPassword.value = ''
    if (mode.value === 'register') {
      mode.value = 'login'
      message.value = '账号创建成功，请登录。'
      return
    }
    if (result.session) session.set(result.session)
    if (result.session?.passwordChangeRequired) {
      void router.replace(props.changePasswordPath)
      return
    }
    const target = router.currentRoute.value.query.returnTo || '/'
    if (
      typeof target === 'string' &&
      (target === '/' || /^\/admin(?:\/[a-z0-9-]+)*\/?$/i.test(target))
    ) {
      void router.push(target)
      return
    }
    account.value = await api('/auth/me')
    session.set(account.value!.session)
  })
}
function logout() {
  void run(async () => {
    await api('/auth/logout', {})
    session.clear()
    account.value = undefined
    message.value = '已退出登录'
  })
}
</script>
<template>
  <main class="auth-account auth-ui">
    <a href="/" aria-label="Antarestra 首页"><AntarestraLogo /></a>
    <p class="eyebrow">ANTARESTRA / ACCOUNT</p>
    <h1>从你的账号开始。</h1>
    <p class="muted">登录 Antarestra，访问你的工作空间。</p>
    <p v-if="message" id="account-message" class="notice" role="status">{{ message }}</p>
    <p v-if="loading">正在加载账号…</p>
    <section v-else-if="account" class="panel">
      <h2>{{ account.principal.display_name }}</h2>
      <p class="muted">主体：{{ account.auth.principalId }}</p>
      <div class="actions">
        <a href="/">进入聊天</a
        ><a v-if="session.snapshot.value?.permissions.includes('admin.console.view')" href="/admin/"
          >管理控制台</a
        ><a :href="changePasswordPath">修改密码</a
        ><button :disabled="busy" @click="logout">退出登录</button>
      </div>
    </section>
    <section v-else class="panel">
      <nav class="auth-tabs" aria-label="账号操作" role="tablist">
        <button
          type="button"
          id="account-login-tab"
          role="tab"
          aria-controls="account-form-panel"
          :aria-selected="mode === 'login'"
          :tabindex="mode === 'login' ? 0 : -1"
          :class="{ active: mode === 'login' }"
          @click="setMode('login')"
          @keydown="moveTab"
        >
          登录</button
        ><button
          v-if="allowRegistration"
          type="button"
          id="account-register-tab"
          role="tab"
          aria-controls="account-form-panel"
          :aria-selected="mode === 'register'"
          :tabindex="mode === 'register' ? 0 : -1"
          :class="{ active: mode === 'register' }"
          @click="setMode('register')"
          @keydown="moveTab"
        >
          创建账号
        </button>
      </nav>
      <form
        id="account-form-panel"
        ref="form"
        role="tabpanel"
        :aria-labelledby="`account-${mode}-tab`"
        novalidate
        @submit.prevent="submit"
      >
        <h2>{{ mode === 'login' ? '欢迎回来' : '创建你的账号' }}</h2>
        <label v-if="mode === 'register'"
          >显示名称<input
            v-model="displayName"
            name="displayName"
            :aria-invalid="invalid === 'displayName'"
            :aria-describedby="message ? 'account-message' : undefined"
            autocomplete="nickname"
            required
            maxlength="128" /></label
        ><label
          >登录名<input
            v-model="loginName"
            name="loginName"
            :aria-invalid="invalid === 'loginName'"
            :aria-describedby="message ? 'account-message' : undefined"
            autocomplete="username"
            required
            maxlength="254" /></label
        ><PasswordField
          v-model="password"
          label="密码"
          name="password"
          :invalid="invalid === 'password'"
          :describedby="message ? 'account-message' : undefined"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          :disabled="busy"
        />
        <PasswordField
          v-if="mode === 'register'"
          v-model="confirmPassword"
          label="重复密码"
          name="confirmPassword"
          :invalid="invalid === 'confirmPassword'"
          :describedby="message ? 'account-message' : undefined"
          autocomplete="new-password"
          :disabled="busy"
        />
        <button class="primary" :disabled="busy">
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
