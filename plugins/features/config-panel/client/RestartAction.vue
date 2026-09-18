<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import { EditorDialog } from '@antarestra/webui/components'
import { useApi } from '@antarestra/webui/api'
const { api, run, busy, message, session, router } = useApi()
const props = defineProps<{ beforeOpen?: () => Promise<boolean> }>()
async function begin() {
  if (!props.beforeOpen || (await props.beforeOpen())) open.value = true
}
function close() {
  open.value = false
  password.value = ''
}
const open = ref(false)
const password = ref('')
const show = ref(false)
const progress = ref('')
let alive = true
onUnmounted(() => {
  alive = false
  password.value = ''
})
async function restart() {
  await run(async () => {
    const current = await api<{ generation: string }>('/plugin-config-panel/restart', {
      password: password.value,
    })
    password.value = ''
    open.value = false
    progress.value = '重启已接受，正在等待服务恢复…'
    const deadline = Date.now() + 120000
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      try {
        const response = await fetch('/api/health', {
          cache: 'no-store',
          signal: AbortSignal.timeout(2000),
        })
        const generation = response.headers.get('X-Antarestra-Generation')
        if (response.ok && generation && generation !== current.generation) {
          const accountPath = session.read()?.accountPath ?? '/auth/user/'
          session.clear()
          location.assign(
            accountPath + '?returnTo=' + encodeURIComponent(router.currentRoute.value.fullPath),
          )
          return
        }
      } catch {
        /* 进程重启期间短暂断开。 */
      }
    }
    if (!alive) return
    progress.value =
      '服务尚未恢复。外部监督模式需要部署平台重新拉起进程；请检查新地址或主配置，再刷新页面。'
  })
  password.value = ''
}
</script>
<template>
  <section class="restart-action">
    <button type="button" :disabled="busy" @click="begin">重启系统</button>
    <p v-if="progress" role="status">{{ progress }}</p>
    <p v-if="message" role="alert">{{ message }}</p>
    <EditorDialog v-if="open" title="验证密码并重启系统" :busy="busy" @close="close">
      <form novalidate @submit.prevent="restart">
        <p>
          当前连接会中断，所有插件将重新初始化。外部数据库不会重启。未保存的配置不会应用，重启后需要重新登录。
        </p>
        <label for="restart-password">当前账号密码</label>
        <div class="password-row">
          <input
            id="restart-password"
            v-model="password"
            :type="show ? 'text' : 'password'"
            autocomplete="current-password"
          /><button type="button" :aria-pressed="show" @click="show = !show">
            {{ show ? '隐藏' : '显示' }}密码
          </button>
        </div>
        <p v-if="message" role="alert">{{ message }}</p>
        <div class="actions">
          <button type="button" :disabled="busy" @click="close">取消</button
          ><button type="submit" :disabled="busy || !password">验证并重启</button>
        </div>
      </form>
    </EditorDialog>
  </section>
</template>
<style scoped>
.restart-action button {
  border: 1px solid #d8dee9;
  background: white;
  color: #263047;
  border-radius: 7px;
  padding: 9px 14px;
  cursor: pointer;
}
.restart-action input {
  min-width: 0;
  flex: 1;
  padding: 10px;
  border: 1px solid #d8dee9;
  border-radius: 7px;
}
.password-row,
.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.actions {
  justify-content: flex-end;
  margin-top: 24px;
}
button:disabled {
  opacity: 0.55;
  cursor: wait;
}
</style>
