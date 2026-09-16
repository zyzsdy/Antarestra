<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from './api.js'
interface Roles {
  roles: { id: string; name: string }[]
  grants: { role_id: string; permission: string }[]
  permissions: { key: string; description: string; defaultRoles: string[] }[]
}
const { api, run, message, busy } = useApi()
const data = ref<Roles>({ roles: [], grants: [], permissions: [] })
const id = ref('')
const name = ref('')
const permissions = ref<string[]>([])
async function load() {
  data.value = await api('/rbac/roles')
}
onMounted(() => run(load))
function edit(role: Roles['roles'][number]) {
  id.value = role.id
  name.value = role.name
  permissions.value = data.value.grants
    .filter((grant) => grant.role_id === role.id)
    .map((grant) => grant.permission)
}
function save() {
  void run(async () => {
    await api(
      `/rbac/roles/${encodeURIComponent(id.value)}`,
      { name: name.value, permissions: permissions.value },
      'PUT',
    )
    await load()
    message.value = '角色已保存'
  })
}
</script>
<template>
  <div class="auth-ui">
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>角色与权限</h2>
          <p class="muted">管理角色拥有的操作权限。</p>
        </div>
        <button :disabled="busy" @click="run(load)">刷新</button>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>角色</th>
              <th>显式授权</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="role in data.roles" :key="role.id">
              <td>
                <strong>{{ role.name }}</strong
                ><small>{{ role.id }}</small>
              </td>
              <td>
                <span
                  v-for="grant in data.grants.filter((g) => g.role_id === role.id)"
                  :key="grant.permission"
                  class="permission-tag"
                  >{{ grant.permission }}</span
                >
              </td>
              <td>
                <button :disabled="busy || role.id === 'administrator'" @click="edit(role)">
                  {{ role.id === 'administrator' ? '内置角色' : '编辑' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h2>创建或更新角色</h2>
      <form @submit.prevent="save">
        <div class="form-grid">
          <label
            >角色标识<input
              v-model="id"
              required
              maxlength="128"
              placeholder="例如 operator" /></label
          ><label
            >角色名称<input v-model="name" required maxlength="128" placeholder="例如 运营人员"
          /></label>
        </div>
        <fieldset>
          <legend>已声明权限</legend>
          <label v-for="permission in data.permissions" :key="permission.key" class="check"
            ><input v-model="permissions" type="checkbox" :value="permission.key" /><span
              ><strong>{{ permission.description }}</strong
              ><small
                >{{ permission.key
                }}<template v-if="permission.defaultRoles.length">
                  · 默认角色：{{ permission.defaultRoles.join('、') }}</template
                ></small
              ></span
            ></label
          >
        </fieldset>
        <p class="muted">内置管理员角色不可修改；只能授予自己已有的权限。</p>
        <button class="primary" :disabled="busy || id === 'administrator'">保存角色</button>
      </form>
    </section>
  </div>
</template>
