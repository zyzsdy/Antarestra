<script setup lang="ts">
import { PaginationField, SelectField } from '@antarestra/webui/components'
import { computed, inject, nextTick, onMounted, ref } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import { useApi } from './api.js'
import RoleAssignment from './RoleAssignment.vue'
import UserCreateDialog from './UserCreateDialog.vue'
import InitialPasswordDialog from './InitialPasswordDialog.vue'
import type { InitialCredentials } from './types.js'
import type { User } from './types.js'
const props = defineProps<{ base: string }>()
const { api, run, message, busy, session, router } = useApi()
const feedback = inject(feedbackKey)!
const users = ref<User[]>([])
const total = ref(0)
const offset = ref(0)
const query = ref(String(router.currentRoute.value.query.q ?? ''))
const status = ref(String(router.currentRoute.value.query.status ?? ''))
const role = ref(String(router.currentRoute.value.query.role ?? ''))
const searchInput = ref<HTMLInputElement>()
const selected = ref<User>()
const creating = ref(false)
const credentials = ref<InitialCredentials>()
const canAssign = computed(() =>
  session.snapshot.value?.permissions.includes('authz.binding.manage'),
)
const canCreate = computed(
  () => canAssign.value && session.snapshot.value?.permissions.includes('identity.local.manage'),
)
async function load(next = offset.value) {
  next = Number.isSafeInteger(next) && next >= 0 ? Math.floor(next / 50) * 50 : 0
  const params = new URLSearchParams({
    offset: String(next),
    q: query.value.trim(),
    status: status.value,
    role: role.value.trim(),
  })
  const result = await api<{ users: User[]; total: number }>(`${props.base}/users?${params}`)
  if (next > 0 && next >= result.total)
    return load(Math.max(0, Math.floor((result.total - 1) / 50) * 50))
  users.value = result.users
  total.value = result.total
  offset.value = next
  await router.replace({
    query: {
      q: params.get('q') || undefined,
      status: params.get('status') || undefined,
      role: params.get('role') || undefined,
      offset: next || undefined,
    },
  })
}
onMounted(() => run(() => load(Math.max(0, Number(router.currentRoute.value.query.offset) || 0))))
function reset() {
  query.value = ''
  status.value = ''
  role.value = ''
  void run(() => load(0))
  searchInput.value?.focus()
}
async function toggle(user: User) {
  const disabling = user.principal.status === 'active'
  if (
    !(await feedback.modal(
      disabling ? '禁用账号' : '启用账号',
      `${disabling ? '禁用' : '启用'}「${user.principal.display_name}」？${disabling ? '该用户将退出登录，且无法继续访问。' : '该用户将可以重新登录。'}`,
    ))
  )
    return
  void run(async () => {
    await api(
      `${props.base}/users/${encodeURIComponent(user.id)}/status`,
      { status: disabling ? 'disabled' : 'active' },
      'PUT',
    )
    await load()
    feedback.toast('账号状态已更新')
  })
}
async function assigned() {
  await run(() => load())
  if (selected.value)
    selected.value = users.value.find((user) => user.id === selected.value?.id) ?? selected.value
}
async function open(user: User) {
  selected.value = user
  await nextTick()
}
function clearSearch() {
  query.value = ''
  void run(() => load(0))
  searchInput.value?.focus()
}
async function created(value: InitialCredentials) {
  creating.value = false
  credentials.value = value
  await run(() => load(0))
}
async function resetPassword(user: User) {
  if (
    !(await feedback.modal(
      '重置密码',
      `为「${user.principal.display_name}」生成新的初始密码？该用户的现有会话将退出。`,
    ))
  )
    return
  void run(async () => {
    credentials.value = await api<InitialCredentials>(
      `${props.base}/users/${encodeURIComponent(user.id)}/reset-password`,
      {},
    )
  })
}
</script>
<template>
  <div class="auth-ui">
    <p v-if="message" class="notice" role="alert">{{ message }}</p>
    <section class="panel" :aria-busy="busy">
      <form class="filter-bar" novalidate @submit.prevent="run(() => load(0))">
        <label class="filter-search"
          >查找用户
          <span class="search-field"
            ><input
              ref="searchInput"
              aria-label="查找用户"
              v-model="query"
              :disabled="busy"
              maxlength="128"
              placeholder="用户名、登录名或主体标识"
            /><button
              v-if="query"
              type="button"
              aria-label="清空用户搜索"
              :disabled="busy"
              @click="clearSearch"
            >
              清空
            </button></span
          >
        </label>
        <label
          >账号状态<SelectField
            v-model="status"
            :disabled="busy"
            label="账号状态"
            :options="[
              { id: '', name: '全部状态' },
              { id: 'active', name: '正常' },
              { id: 'disabled', name: '已禁用' },
            ]"
        /></label>
        <label
          >角色 ID<input v-model="role" :disabled="busy" maxlength="64" placeholder="全部角色"
        /></label>
        <div class="actions">
          <button class="primary" :disabled="busy">查询</button
          ><button type="button" :disabled="busy" @click="reset">重置</button>
        </div>
      </form>
      <div class="list-summary">
        <span>共 {{ total }} 位用户</span><span v-if="busy" role="status">正在加载…</span>
        <div class="list-actions">
          <button v-if="canCreate" class="primary" :disabled="busy" @click="creating = true">
            新建用户
          </button>
          <button
            class="icon-button"
            type="button"
            :disabled="busy"
            aria-label="刷新用户列表"
            title="刷新用户列表"
            @click="run(() => load())"
          >
            <ArrowPathIcon class="ui-icon" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>所属角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td class="user-cell">
                <strong>{{ user.principal.display_name || user.email }}</strong
                ><small>{{ user.email }}</small
                ><small class="mono">{{ user.principal_id }}</small>
              </td>
              <td>
                <span v-for="(item, index) in user.roles" :key="index" class="permission-tag"
                  >{{ item.name
                  }}<small
                    >{{ item.id
                    }}<template v-if="item.scope !== 'system'"> · {{ item.scope }}</template></small
                  ></span
                >
              </td>
              <td>
                <span class="badge" :class="{ inactive: user.principal.status !== 'active' }">{{
                  user.principal.status === 'active' ? '正常' : '已禁用'
                }}</span>
              </td>
              <td>
                <div class="actions">
                  <button v-if="canAssign" :disabled="busy" @click="open(user)">分配角色</button
                  ><button :disabled="busy" @click="resetPassword(user)">重置密码</button
                  ><button
                    :disabled="
                      busy ||
                      user.principal_id === session.read()?.actorId ||
                      user.roles.some((item) => item.id === 'admin')
                    "
                    @click="toggle(user)"
                  >
                    {{ user.principal.status === 'active' ? '禁用账号' : '启用账号' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!users.length" class="empty">
        {{ busy ? '正在加载用户…' : '没有符合条件的用户，请调整筛选条件。' }}
      </p>
      <PaginationField
        :page="offset / 50 + 1"
        :total="total"
        :page-size="50"
        :disabled="busy"
        class="pagination"
        label="用户分页"
        @update:page="run(() => load(($event - 1) * 50))"
      >
        第 {{ offset / 50 + 1 }} 页 · 每页 50 条
      </PaginationField>
    </section>
    <RoleAssignment
      v-if="selected"
      :user="selected"
      @close="selected = undefined"
      @saved="assigned"
    />
    <UserCreateDialog v-if="creating" :base="base" @close="creating = false" @created="created" />
    <InitialPasswordDialog
      v-if="credentials"
      :credentials="credentials"
      @close="credentials = undefined"
    />
  </div>
</template>
