<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from './api.js'
import PasswordField from './PasswordField.vue'
const props = defineProps<{ base: string; accountPath: string }>()
const { api, run, message, busy, session, router } = useApi()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const invalid = ref('')
const form = ref<HTMLFormElement>()
function submit() {
  void run(async () => {
    invalid.value =
      currentPassword.value.length < 8 || currentPassword.value.length > 128
        ? 'currentPassword'
        : newPassword.value.length < 8 || newPassword.value.length > 128
          ? 'newPassword'
          : newPassword.value !== confirmPassword.value
            ? 'confirmPassword'
            : ''
    if (invalid.value) {
      form.value?.querySelector<HTMLInputElement>(`[name="${invalid.value}"]`)?.focus()
      throw new Error(
        invalid.value === 'confirmPassword'
          ? '两次输入的新密码不一致。'
          : '密码长度必须为 8–128 个字符。',
      )
    }
    const result = await api<{ session: NonNullable<ReturnType<typeof session.read>> }>(
      `${props.base}/password`,
      { currentPassword: currentPassword.value, newPassword: newPassword.value },
    )
    session.set(result.session)
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    void router.replace(props.accountPath)
  })
}
function logout() {
  void run(async () => {
    await api('/auth/logout', {})
    session.clear()
    void router.replace(props.accountPath)
  })
}
</script>
<template>
  <main class="auth-account auth-ui">
    <p class="eyebrow">ANTARESTRA / SECURITY</p>
    <h1>修改密码</h1>
    <p class="muted">密码区分大小写，长度为 8–128 个字符。</p>
    <section class="panel">
      <p v-if="session.read()?.passwordChangeRequired" class="notice">
        当前使用的是初始密码。继续使用其他功能前，请先设置自己的密码。
      </p>
      <p v-if="message" id="password-message" class="notice" role="alert">{{ message }}</p>
      <form ref="form" novalidate @submit.prevent="submit">
        <PasswordField
          v-model="currentPassword"
          label="原密码"
          name="currentPassword"
          autocomplete="current-password"
          :invalid="invalid === 'currentPassword'"
          :describedby="message ? 'password-message' : undefined"
          :disabled="busy"
        />
        <PasswordField
          v-model="newPassword"
          label="新密码"
          name="newPassword"
          autocomplete="new-password"
          :invalid="invalid === 'newPassword'"
          :describedby="message ? 'password-message' : undefined"
          :disabled="busy"
        />
        <PasswordField
          v-model="confirmPassword"
          label="重复新密码"
          name="confirmPassword"
          autocomplete="new-password"
          :invalid="invalid === 'confirmPassword'"
          :describedby="message ? 'password-message' : undefined"
          :disabled="busy"
        />
        <div class="actions">
          <button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存新密码' }}</button>
          <a v-if="!session.read()?.passwordChangeRequired" :href="accountPath">返回用户中心</a>
          <button v-else type="button" :disabled="busy" @click="logout">退出登录</button>
        </div>
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
