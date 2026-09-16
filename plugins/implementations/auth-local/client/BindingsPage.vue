<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from './api.js'
interface Binding {
  role_id: string
  scope: string
  source: string
  expires_at: number | null
}
const { api, run, message, busy } = useApi()
const principalId = ref('')
const roleId = ref('')
const scope = ref('system')
const rows = ref<Binding[]>([])
const loaded = ref('')
function clearBindings() {
  loaded.value = ''
  rows.value = []
}
async function load() {
  if (!principalId.value.trim()) throw new Error('请先填写主体标识')
  rows.value = await api(`/rbac/bindings/${encodeURIComponent(principalId.value)}`)
  loaded.value = principalId.value
}
function save(enabled: boolean) {
  void run(async () => {
    await api(
      `/rbac/bindings/${encodeURIComponent(principalId.value)}`,
      { roleId: roleId.value, scope: scope.value, enabled },
      'PUT',
    )
    await load()
    message.value = '角色绑定已更新'
  })
}
</script>
<template>
  <div class="auth-ui">
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <section class="panel">
      <h2>角色分配</h2>
      <p class="muted">将角色授予指定用户，并设置授权范围。</p>
      <form @submit.prevent="save(true)">
        <label
          >主体标识<input
            v-model="principalId"
            required
            maxlength="128"
            placeholder="从本地用户页面复制主体标识"
            @input="clearBindings"
        /></label>
        <div class="form-grid">
          <label
            >角色标识<input
              v-model="roleId"
              required
              maxlength="128"
              placeholder="例如 operator" /></label
          ><label>授权范围<input v-model="scope" required maxlength="128" /></label>
        </div>
        <p class="muted">system 用于系统管理；空间权限必须绑定到准确的空间标识。</p>
        <div class="actions">
          <button class="primary" :disabled="busy">授予角色</button
          ><button
            type="button"
            :disabled="busy || !principalId || !roleId || !scope"
            @click="save(false)"
          >
            撤销手动绑定</button
          ><button type="button" :disabled="busy || !principalId" @click="run(load)">
            查看绑定
          </button>
        </div>
      </form>
    </section>
    <section v-if="loaded" class="panel">
      <h2>当前角色绑定</h2>
      <p class="muted">{{ loaded }}</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>角色</th>
              <th>范围</th>
              <th>来源</th>
              <th>有效期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rows" :key="index">
              <td>{{ row.role_id }}</td>
              <td>{{ row.scope }}</td>
              <td>{{ row.source }}</td>
              <td>{{ row.expires_at ? new Date(row.expires_at).toLocaleString() : '长期' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!rows.length" class="empty">暂无角色绑定</p>
    </section>
  </div>
</template>
