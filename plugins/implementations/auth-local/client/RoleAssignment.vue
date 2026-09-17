<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { EditorDialog, EditableSelect } from '@antarestra/webui/components'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from './api.js'
import type { User, UserRole } from './types.js'
const props = defineProps<{ user: User }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { api, run, message, busy } = useApi()
const feedback = inject(feedbackKey)!
const options = ref<{ id: string; name: string }[]>([])
const roles = ref<UserRole[]>(props.user.roles)
const roleId = ref('')
const scope = ref('system')
const input = ref<InstanceType<typeof EditableSelect>>()
const dirty = computed(() => !!roleId.value || scope.value !== 'system')
onMounted(() =>
  run(async () => {
    options.value = await api('/rbac/role-options')
  }),
)
async function close() {
  if (
    dirty.value &&
    !(await feedback.modal('放弃未保存的角色分配', '输入的角色和授权范围尚未保存，确定关闭？'))
  )
    return
  emit('close')
}
function save(enabled: boolean, existing?: UserRole) {
  void run(async () => {
    const id = existing?.id ?? roleId.value.trim()
    const targetScope = existing?.scope ?? scope.value.trim()
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
      input.value?.focus()
      throw new Error(
        '角色 ID 必须以小写字母开头，仅含小写字母、数字、下划线或连字符，最多 64 位。',
      )
    }
    if (!targetScope || targetScope.length > 128) throw new Error('请填写 1–128 字的授权范围。')
    if (
      !enabled &&
      !(await feedback.modal(
        '撤销角色',
        `撤销「${props.user.principal.display_name}」在「${targetScope}」中的「${id}」手动绑定？`,
      ))
    )
      return
    await api(
      `/rbac/bindings/${encodeURIComponent(props.user.principal_id)}`,
      { roleId: id, scope: targetScope, enabled },
      'PUT',
    )
    const rows = await api<
      { role_id: string; scope: string; source: string; expires_at: number | null }[]
    >(`/rbac/bindings/${encodeURIComponent(props.user.principal_id)}`)
    options.value = await api('/rbac/role-options')
    roles.value = [
      {
        id: 'user',
        name: options.value.find((role) => role.id === 'user')?.name ?? '普通用户',
        scope: 'system',
        source: 'default',
        expires_at: null,
      },
      ...rows
        .filter((row) => !row.expires_at || row.expires_at > Date.now())
        .map((row) => ({
          ...row,
          id: row.role_id,
          name: options.value.find((role) => role.id === row.role_id)?.name ?? row.role_id,
        })),
    ]
    roleId.value = ''
    scope.value = 'system'
    feedback.toast(enabled ? '角色已分配' : '手动角色绑定已撤销')
    emit('saved')
  })
}
</script>
<template>
  <EditorDialog title="分配角色" :busy="busy" @close="close">
    <p>
      <strong>{{ user.principal.display_name }}</strong
      ><small>{{ user.email }}</small>
    </p>
    <p v-if="message" class="notice" role="alert">{{ message }}</p>
    <div class="binding-list">
      <div v-for="(item, index) in roles" :key="index" class="binding-row">
        <div>
          <strong>{{ item.name }}</strong
          ><small
            >{{ item.id }} · {{ item.scope }} ·
            {{
              item.source === 'default'
                ? '默认角色'
                : item.source === 'manual'
                  ? '手动分配'
                  : '初始化或插件分配'
            }}</small
          >
        </div>
        <button v-if="item.source === 'manual'" :disabled="busy" @click="save(false, item)">
          撤销
        </button>
      </div>
    </div>
    <form novalidate @submit.prevent="save(true)">
      <div class="assignment-field">
        <span>角色</span
        ><EditableSelect
          ref="input"
          v-model="roleId"
          :options="options"
          label="角色"
          :disabled="busy"
        />
      </div>
      <p class="muted">可选择已有角色，也可输入新的角色 ID；新角色创建后暂无额外权限。</p>
      <label>授权范围<input v-model="scope" maxlength="128" :disabled="busy" /></label>
      <p class="muted">system 仅用于系统管理。空间权限请填写准确的空间标识。</p>
      <div class="actions">
        <button class="primary" :disabled="busy">保存角色分配</button
        ><button type="button" :disabled="busy" @click="close">完成</button>
      </div>
    </form>
  </EditorDialog>
</template>
