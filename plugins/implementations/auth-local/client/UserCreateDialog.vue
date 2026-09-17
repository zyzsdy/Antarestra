<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { EditorDialog, EditableSelect } from '@antarestra/webui/components'
import { useApi } from './api.js'
import type { InitialCredentials } from './types.js'
const props = defineProps<{ base: string }>()
const emit = defineEmits<{ close: []; created: [credentials: InitialCredentials] }>()
const { api, run, message, busy } = useApi()
const loginName = ref('')
const displayName = ref('')
const roleId = ref('user')
const options = ref<{ id: string; name: string }[]>([])
const form = ref<HTMLFormElement>()
const invalid = ref('')
onMounted(() =>
  run(async () => {
    options.value = await api('/rbac/role-options')
  }),
)
function submit() {
  void run(async () => {
    invalid.value = !loginName.value.trim()
      ? 'loginName'
      : !displayName.value.trim()
        ? 'displayName'
        : !options.value.some((option) => option.id === roleId.value)
          ? 'roleId'
          : ''
    if (invalid.value) {
      form.value?.querySelector<HTMLElement>(`[name="${invalid.value}"]`)?.focus()
      throw new Error(
        invalid.value === 'loginName'
          ? '请填写登录名。'
          : invalid.value === 'displayName'
            ? '请填写用户名。'
            : '请选择已有且可用的初始角色。',
      )
    }
    const credentials = await api<InitialCredentials>(`${props.base}/users`, {
      loginName: loginName.value,
      displayName: displayName.value,
      roleId: roleId.value,
    })
    emit('created', credentials)
  })
}
</script>
<template>
  <EditorDialog title="新建用户" :busy="busy" @close="emit('close')">
    <p v-if="message" id="create-user-message" class="notice" role="alert">{{ message }}</p>
    <form ref="form" novalidate @submit.prevent="submit">
      <label
        >登录名<input
          v-model="loginName"
          name="loginName"
          autocomplete="off"
          maxlength="254"
          :disabled="busy"
          :aria-invalid="invalid === 'loginName'"
          :aria-describedby="message ? 'create-user-message' : undefined"
      /></label>
      <label
        >用户名<input
          v-model="displayName"
          name="displayName"
          autocomplete="off"
          maxlength="128"
          :disabled="busy"
          :aria-invalid="invalid === 'displayName'"
          :aria-describedby="message ? 'create-user-message' : undefined"
      /></label>
      <div class="assignment-field">
        <span>初始角色</span>
        <EditableSelect v-model="roleId" :options="options" label="初始角色" :disabled="busy" />
      </div>
      <p class="muted">默认为普通用户。账号创建后会生成一次性显示的 16 位初始密码。</p>
      <div class="actions">
        <button class="primary" :disabled="busy">{{ busy ? '正在创建…' : '创建用户' }}</button>
        <button type="button" :disabled="busy" @click="emit('close')">取消</button>
      </div>
    </form>
  </EditorDialog>
</template>
