<script setup lang="ts">
import { PaginationField, CheckboxField } from '@antarestra/webui/components'
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from './api.js'
import type { Roles } from './types.js'
const { api, run, message, busy, router } = useApi()
const feedback = inject(feedbackKey)!
const data = ref<Roles>({ roles: [], grants: [], permissions: [] })
const editing = ref(false)
const creating = ref(false)
const id = ref('')
const name = ref('')
const permissions = ref<string[]>([])
const query = ref('')
const roleQuery = ref('')
const page = ref(0)
const baseline = ref('')
const panel = ref<HTMLElement>()
const searchInput = ref<HTMLInputElement>()
const roleSearch = ref<HTMLInputElement>()
const snapshot = () => JSON.stringify([id.value, name.value, [...permissions.value].sort()])
const dirty = computed(() => editing.value && snapshot() !== baseline.value)
const defaults = computed(() =>
  data.value.permissions.filter((p) => p.defaultRoles.includes(id.value)).map((p) => p.key),
)
const visible = computed(() =>
  data.value.permissions.filter((p) =>
    `${p.key} ${p.description}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()),
  ),
)
const roles = computed(() =>
  data.value.roles.filter((r) =>
    `${r.id} ${r.name}`.toLocaleLowerCase().includes(roleQuery.value.toLocaleLowerCase()),
  ),
)
const shownRoles = computed(() => roles.value.slice(page.value * 20, (page.value + 1) * 20))
const selectedCount = computed(() => new Set([...defaults.value, ...permissions.value]).size)
function count(role: string) {
  return new Set([
    ...data.value.permissions.filter((p) => p.defaultRoles.includes(role)).map((p) => p.key),
    ...data.value.grants.filter((g) => g.role_id === role).map((g) => g.permission),
  ]).size
}
async function load() {
  data.value = await api('/rbac/roles')
}
onMounted(() => run(load))
async function discard() {
  return (
    !dirty.value || (await feedback.modal('放弃未保存的权限修改', '尚有修改未保存，确定放弃？'))
  )
}
async function edit(role?: Roles['roles'][number]) {
  if (!(await discard())) return
  creating.value = !role
  editing.value = true
  id.value = role?.id ?? ''
  name.value = role?.name ?? ''
  query.value = ''
  permissions.value = data.value.grants
    .filter((g) => g.role_id === role?.id)
    .map((g) => g.permission)
    .filter((key) => !defaults.value.includes(key))
  baseline.value = snapshot()
  await nextTick()
  panel.value?.focus()
  panel.value?.scrollIntoView({ behavior: 'instant', block: 'nearest' })
}
async function cancel() {
  if (await discard()) editing.value = false
}
async function refresh() {
  if (!(await discard())) return
  await run(async () => {
    await load()
    editing.value = false
  })
}
function toggle(key: string, checked: boolean) {
  permissions.value = checked
    ? [...new Set([...permissions.value, key])]
    : permissions.value.filter((p) => p !== key)
}
function save() {
  void run(async () => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id.value))
      throw new Error(
        '角色 ID 必须以小写字母开头，仅含小写字母、数字、下划线或连字符，最多 64 位。',
      )
    if (!name.value.trim()) throw new Error('请填写角色名称。')
    if (creating.value && data.value.roles.some((role) => role.id === id.value))
      throw new Error('该角色已存在，请从列表中选择编辑。')
    await api(
      `/rbac/roles/${encodeURIComponent(id.value)}`,
      {
        name: name.value.trim(),
        permissions: permissions.value.filter((key) => !defaults.value.includes(key)),
      },
      'PUT',
    )
    baseline.value = snapshot()
    creating.value = false
    feedback.toast('角色权限已保存')
    await load()
  })
}
const removeGuard = router.beforeEach(async () => await discard())
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onUnmounted(() => {
  removeGuard()
  window.removeEventListener('beforeunload', beforeUnload)
})
function clearRoles() {
  roleQuery.value = ''
  page.value = 0
  roleSearch.value?.focus()
}
function clearPermissions() {
  query.value = ''
  searchInput.value?.focus()
}
</script>
<template>
  <div class="auth-ui">
    <p v-if="message" class="notice" role="alert">{{ message }}</p>
    <section class="panel" :aria-busy="busy">
      <div class="section-heading">
        <div>
          <h2>系统角色</h2>
          <p class="muted">选择角色，查看并调整它的操作权限。</p>
        </div>
        <div class="actions">
          <button :disabled="busy" @click="refresh">刷新列表</button>
          <button class="primary" :disabled="busy" @click="edit()">创建角色</button>
        </div>
      </div>
      <label
        >查找角色<span class="search-field"
          ><input
            ref="roleSearch"
            aria-label="查找角色"
            v-model="roleQuery"
            placeholder="角色 ID 或名称"
            @input="page = 0"
          /><button v-if="roleQuery" type="button" aria-label="清空角色筛选" @click="clearRoles">
            清空
          </button></span
        ></label
      >
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>角色</th>
              <th>类型</th>
              <th>权限数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="role in shownRoles"
              :key="role.id"
              :class="{ 'selected-row': editing && id === role.id }"
            >
              <td>
                <strong>{{ role.name }}</strong
                ><small class="mono">{{ role.id }}</small>
              </td>
              <td>{{ ['admin', 'user', 'guest'].includes(role.id) ? '系统内置' : '自定义' }}</td>
              <td>{{ count(role.id) }} 项</td>
              <td>
                <button
                  :disabled="busy"
                  :aria-expanded="editing && id === role.id"
                  @click="edit(role)"
                >
                  编辑
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!roles.length" class="empty">
        {{ busy ? '正在加载角色…' : '没有符合条件的角色。' }}
      </p>
      <PaginationField
        :page="page + 1"
        :total="roles.length"
        :page-size="20"
        :disabled="busy"
        class="pagination"
        label="角色分页"
        @update:page="page = $event - 1"
      >
        共 {{ roles.length }} 个角色
      </PaginationField>
    </section>
    <section v-if="editing" ref="panel" class="panel role-editor" tabindex="-1">
      <div class="section-heading">
        <div>
          <h2>{{ creating ? '创建角色' : `编辑权限 · ${name}` }}</h2>
          <p class="muted">默认权限始终生效，仅保存额外授权。</p>
        </div>
        <span class="permission-tag">已选 {{ selectedCount }} 项</span>
      </div>
      <form novalidate @submit.prevent="save">
        <div class="form-grid">
          <label
            >角色 ID<input
              v-model="id"
              :disabled="busy || !creating"
              maxlength="64"
              placeholder="例如 operator" /></label
          ><label
            >角色名称<input
              v-model="name"
              :disabled="busy"
              maxlength="128"
              placeholder="例如 运营人员"
          /></label>
        </div>
        <label
          >筛选权限<span class="search-field"
            ><input
              ref="searchInput"
              aria-label="筛选权限"
              v-model="query"
              placeholder="输入权限 ID 或描述"
            /><button
              v-if="query"
              type="button"
              aria-label="清空权限筛选"
              @click="clearPermissions"
            >
              清空
            </button></span
          ></label
        >
        <p class="muted">
          显示 {{ visible.length }} 项权限 · 筛选不会清除已勾选项。默认权限已锁定。
        </p>
        <fieldset class="permissions-grid">
          <legend>角色权限</legend>
          <label
            v-for="permission in visible"
            :key="permission.key"
            class="check"
            :class="{ 'default-permission': defaults.includes(permission.key) }"
            ><CheckboxField
              :checked="defaults.includes(permission.key) || permissions.includes(permission.key)"
              :disabled="busy || defaults.includes(permission.key)"
              @change="toggle(permission.key, $event)"
            /><span
              ><strong>{{ permission.description }}</strong
              ><small class="mono">{{ permission.key }}</small
              ><small v-if="defaults.includes(permission.key)">默认权限 · 不可取消</small></span
            ></label
          >
          <p v-if="!visible.length" class="empty">没有符合条件的权限，请更换关键词。</p>
        </fieldset>
        <p class="muted">只能授予自己已有的权限。保存后立即生效。</p>
        <div class="actions">
          <button class="primary" :disabled="busy || !dirty">保存角色权限</button
          ><button type="button" :disabled="busy" @click="cancel">取消</button
          ><span v-if="dirty" class="muted">有未保存的修改</span>
        </div>
      </form>
    </section>
    <section v-else class="panel empty">点击角色右侧的“编辑”，在这里配置权限。</section>
  </div>
</template>
