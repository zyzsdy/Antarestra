<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog } from '@antarestra/webui/components'

const props = defineProps<{ workspaceId: string; name: string }>()
const emit = defineEmits<{ close: [] }>()
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const draft = ref(''),
  saved = ref(''),
  revision = ref(0),
  loaded = ref(false)
const invalid = ref(false),
  input = ref<HTMLTextAreaElement>()
const dirty = computed(() => draft.value !== saved.value)
const base = `/im/groups/${encodeURIComponent(props.workspaceId)}/admins`
async function load() {
  const value = await api<{ users: string[]; revision: number }>(base)
  draft.value = saved.value = value.users.join('\n')
  revision.value = value.revision
  loaded.value = true
}
async function mayLeave() {
  if (busy.value) return false
  return !dirty.value || (await feedback.modal('放弃管理员修改？', '尚未保存的管理员名单将丢失。'))
}
async function close() {
  if (await mayLeave()) emit('close')
}
function save() {
  if (busy.value) return
  const users = [
    ...new Set(
      draft.value
        .split(/\r?\n/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ]
  invalid.value = users.length > 200 || users.some((id) => id.length > 200 || /\s/.test(id))
  if (invalid.value) {
    input.value?.focus()
    message.value = '每行填写一个不含空白的用户 ID，最多 200 人，每个 ID 最多 200 个字符。'
    return
  }
  void run(async () => {
    await api(base, { users, revision: revision.value }, 'PUT')
    saved.value = draft.value
    feedback.toast('当前群的 bot 管理员已保存')
    emit('close')
  })
}
const stopGuard = router.beforeEach((to, from) => to.fullPath === from.fullPath || mayLeave())
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
onMounted(() => {
  void run(load)
  window.addEventListener('beforeunload', beforeUnload)
})
onUnmounted(() => {
  stopGuard()
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
<template>
  <EditorDialog :title="`${name} · bot 管理员`" :busy="busy" @close="close">
    <form id="group-admins-form" class="im-form" novalidate @submit.prevent="save">
      <p class="im-hint">
        群主自动拥有 bot 管理权限。以下名单仅对当前群生效，普通平台群管理员不会自动获得权限。
      </p>
      <p v-if="!loaded" role="status">{{ busy ? '正在加载管理员…' : '名单尚未加载。' }}</p>
      <label v-else for="group-admin-users"
        >额外的 bot 管理员（每行一个平台用户 ID）
        <textarea
          id="group-admin-users"
          ref="input"
          v-model="draft"
          rows="7"
          style="resize: none"
          :disabled="busy"
          :aria-invalid="invalid"
          aria-describedby="group-admins-message"
        />
      </label>
      <p id="group-admins-message" :role="message ? 'alert' : undefined" class="im-error">
        {{ message }}
      </p>
      <button v-if="!loaded && !busy" type="button" @click="run(load)">重新加载</button>
    </form>
    <template #footer
      ><button :disabled="busy" @click="close">取消</button
      ><button form="group-admins-form" class="im-primary" :disabled="busy || !loaded">
        {{ busy ? '处理中…' : '保存管理员' }}
      </button></template
    >
  </EditorDialog>
</template>
