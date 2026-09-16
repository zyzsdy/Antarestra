<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from './api.js'
const props = defineProps<{ base: string }>()
interface User {
  id: string
  email: string
  principal_id: string
  principal?: { display_name: string; status: string }
}
const { api, run, message, busy } = useApi()
const users = ref<User[]>([])
const offset = ref(0)
const actorId = ref('')
async function load(next = offset.value) {
  const rows = await api<User[]>(`${props.base}/users?offset=${next}`)
  users.value = rows
  offset.value = next
}
onMounted(() =>
  run(async () => {
    const me = await api<{ auth: { principalId: string } }>('/auth/me')
    actorId.value = me.auth.principalId
    await load()
  }),
)
function toggle(user: User) {
  void run(async () => {
    await api(
      `${props.base}/users/${encodeURIComponent(user.id)}/status`,
      { status: user.principal?.status === 'active' ? 'disabled' : 'active' },
      'PUT',
    )
    await load()
    message.value = '账号状态已更新'
  })
}
</script>
<template>
  <div class="auth-ui">
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>本地用户</h2>
          <p class="muted">查看账号状态，管理用户的访问资格。</p>
        </div>
        <button :disabled="busy" @click="run(() => load())">刷新列表</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>主体标识</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td>
                <strong>{{ user.principal?.display_name || user.email }}</strong
                ><small>{{ user.email }}</small>
              </td>
              <td class="mono">{{ user.principal_id }}</td>
              <td>
                <span class="badge" :class="{ inactive: user.principal?.status !== 'active' }">{{
                  user.principal?.status === 'active' ? '正常' : '已禁用'
                }}</span>
              </td>
              <td>
                <button :disabled="busy || user.principal_id === actorId" @click="toggle(user)">
                  {{ user.principal?.status === 'active' ? '禁用账号' : '启用账号' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!users.length" class="empty">{{ busy ? '正在加载用户…' : '暂无用户' }}</p>
      <div class="pagination">
        <span class="muted">第 {{ offset / 50 + 1 }} 页 · 每页最多 50 条</span>
        <div class="actions">
          <button
            :disabled="busy || offset === 0"
            @click="run(() => load(Math.max(0, offset - 50)))"
          >
            上一页</button
          ><button :disabled="busy || users.length < 50" @click="run(() => load(offset + 50))">
            下一页
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
