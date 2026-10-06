<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog } from '@antarestra/webui/components'

const props = defineProps<{ prefix: string }>()
const emit = defineEmits<{ close: []; saved: [name: string] }>()
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const name = ref(''),
  target = ref(''),
  completed = ref(false),
  composing = ref(false)
const invalid = ref<'name' | 'target'>()
const nameInput = ref<HTMLInputElement>(),
  targetInput = ref<HTMLTextAreaElement>()
const dirty = computed(() => !completed.value && !!(name.value || target.value))
async function mayLeave() {
  return (
    !busy.value &&
    (!dirty.value || (await feedback.modal('放弃未保存的命令别名？', '当前输入将丢失。')))
  )
}
async function close() {
  if (await mayLeave()) emit('close')
}
function save() {
  if (busy.value || composing.value) return
  invalid.value = undefined
  const supplied = name.value.trim()
  const normalized = supplied.startsWith(props.prefix)
    ? supplied.slice(props.prefix.length)
    : supplied
  if (!/^[a-zA-Z0-9][\w-]*$/.test(normalized) || normalized.length > 200) {
    invalid.value = 'name'
    message.value = '别名须以字母或数字开头，只能包含字母、数字、下划线和连字符，最多 200 字符。'
    nameInput.value?.focus()
    return
  }
  if (!target.value.trimStart().startsWith(props.prefix) || target.value.length > 8192) {
    invalid.value = 'target'
    message.value = `请填写以 ${props.prefix} 开头的目标命令与参数，最多 8192 字符。`
    targetInput.value?.focus()
    return
  }
  void run(async () => {
    const data = await api<{ name: string }>('/im/command-aliases', {
      name: supplied,
      target: target.value,
    })
    completed.value = true
    feedback.toast('命令别名已添加，请配置使用权限')
    emit('saved', data.name)
  })
}
const stopGuard = router.beforeEach((to, from) => to.fullPath === from.fullPath || mayLeave())
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onUnmounted(() => {
  stopGuard()
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <EditorDialog title="添加命令别名" :busy="busy" class="im-editor" @close="close">
    <form
      id="command-alias-form"
      class="im-form"
      novalidate
      @submit.prevent="save"
      @compositionstart="composing = true"
      @compositionend="composing = false"
    >
      <label for="command-alias-name">命令别名</label>
      <input
        id="command-alias-name"
        ref="nameInput"
        v-model="name"
        :disabled="busy"
        :maxlength="200 + prefix.length"
        :placeholder="`${prefix}user1Commit`"
        :aria-invalid="invalid === 'name'"
        aria-describedby="command-alias-name-hint command-alias-error"
      />
      <p id="command-alias-name-hint" class="im-hint">区分大小写，不能与已有命令或别名重名。</p>
      <label for="command-alias-target">转发到的命令和参数</label>
      <textarea
        id="command-alias-target"
        ref="targetInput"
        v-model="target"
        :disabled="busy"
        maxlength="8192"
        rows="3"
        style="resize: none"
        :placeholder="`${prefix}commit user1`"
        :aria-invalid="invalid === 'target'"
        aria-describedby="command-alias-target-hint command-alias-error"
      />
      <p id="command-alias-target-hint" class="im-hint">
        目标须为已注册命令。调用别名时附带的参数会原样追加在这里填写的参数后。
      </p>
      <p class="im-hint">
        别名有独立的群聊、私聊名单和授权级别。新别名默认禁止所有聊天使用，添加后请配置权限。
      </p>
      <p id="command-alias-error" class="im-error" :role="message ? 'alert' : undefined">
        {{ message }}
      </p>
    </form>
    <template #footer>
      <button :disabled="busy" @click="close">取消</button>
      <button form="command-alias-form" type="submit" class="im-primary" :disabled="busy">
        {{ busy ? '正在添加…' : '添加别名' }}
      </button>
    </template>
  </EditorDialog>
</template>
