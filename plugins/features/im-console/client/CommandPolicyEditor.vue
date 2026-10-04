<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog, SelectField } from '@antarestra/webui/components'
import type { CommandPolicy, CommandPolicyState } from '@antarestra/plugin-im-commands'

const props = defineProps<{ name: string; prefix: string }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const draft = reactive({
  access: 'user',
  groupMode: 'whitelist',
  group: '',
  privateMode: 'whitelist',
  private: '',
})
const saved = ref(''),
  revision = ref(0),
  loaded = ref(false)
const invalid = ref<'group' | 'private'>()
const groupInput = ref<HTMLTextAreaElement>(),
  privateInput = ref<HTMLTextAreaElement>()
const dirty = computed(() => loaded.value && JSON.stringify(draft) !== saved.value)
const base = `/im/commands/${encodeURIComponent(props.name)}`
const levels = [
  { id: 'user', name: '普通群友' },
  { id: 'bot-admin', name: 'bot 管理员' },
]
const modes = [
  { id: 'whitelist', name: '白名单' },
  { id: 'blacklist', name: '黑名单' },
]
const scopes = [
  { key: 'group', mode: 'groupMode', label: '群聊', idLabel: '群 ID' },
  { key: 'private', mode: 'privateMode', label: '私聊', idLabel: '用户 ID' },
] as const
async function load() {
  const data = await api<CommandPolicyState>(base)
  Object.assign(draft, {
    access: data.policy.access,
    groupMode: data.policy.group.mode,
    group: data.policy.group.ids.join('\n'),
    privateMode: data.policy.private.mode,
    private: data.policy.private.ids.join('\n'),
  })
  revision.value = data.revision
  loaded.value = true
  saved.value = JSON.stringify(draft)
  invalid.value = undefined
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的命令权限？', '当前修改将丢失，已保存的权限不受影响。'))
  )
}
async function mayLeave() {
  return !busy.value && (await discard())
}
async function close() {
  if (await mayLeave()) emit('close')
}
async function reload() {
  if (!busy.value && (await discard())) await run(load)
}
function ids(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ]
}
function save() {
  if (busy.value || !loaded.value) return
  const group = ids(draft.group),
    privateIds = ids(draft.private)
  invalid.value = undefined
  for (const [key, values] of [
    ['group', group],
    ['private', privateIds],
  ] as const) {
    if (
      values.length > 1000 ||
      values.some((id) => id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id))
    ) {
      invalid.value = key
      message.value = '每行填写一个不含空白的 ID，每个 ID 最多 200 字符，每份名单最多 1000 项。'
      ;(key === 'group' ? groupInput : privateInput).value?.focus()
      return
    }
  }
  const policy: CommandPolicy = {
    access: draft.access as CommandPolicy['access'],
    group: { mode: draft.groupMode as CommandPolicy['group']['mode'], ids: group },
    private: { mode: draft.privateMode as CommandPolicy['private']['mode'], ids: privateIds },
  }
  void run(async () => {
    await api(base, { policy, revision: revision.value }, 'PUT')
    saved.value = JSON.stringify(draft)
    feedback.toast(`${props.prefix}${props.name} 命令权限已保存`)
    emit('saved')
  })
}
const stopGuard = router.beforeEach((to, from) => to.fullPath === from.fullPath || mayLeave())
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
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
  <EditorDialog
    :title="`${prefix}${name} · 命令权限`"
    :busy="busy"
    class="im-editor"
    @close="close"
  >
    <form id="command-policy-form" class="im-form" novalidate @submit.prevent="save">
      <p v-if="!loaded" role="status">
        {{ busy ? '正在加载命令权限…' : '命令权限尚未加载，请重试。' }}
      </p>
      <template v-else>
        <p class="im-hint">
          同一指令的所有子命令共用权限。名单对所有接入生效，各接入的准入限制仍须满足。
        </p>
        <label for="command-access">授权级别</label>
        <SelectField
          id="command-access"
          v-model="draft.access"
          label="授权级别"
          :options="levels"
          :disabled="busy"
        />
        <p class="im-hint">群聊中的高级命令仅允许本群 bot 管理员和群主执行；私聊忽略授权级别。</p>
        <div class="im-grid">
          <section v-for="scope in scopes" :key="scope.key" class="im-form-section">
            <h3>{{ scope.label }}</h3>
            <label :for="`command-${scope.key}-mode`">{{ scope.label }}权限</label>
            <SelectField
              :id="`command-${scope.key}-mode`"
              v-model="draft[scope.mode]"
              :label="`${scope.label}权限`"
              :options="modes"
              :disabled="busy"
            />
            <label :for="`command-${scope.key}-ids`"
              >{{ scope.label }}列表（{{
                draft[scope.mode] === 'whitelist' ? '允许列表' : '禁止列表'
              }}，每行一个{{ scope.idLabel }}）</label
            >
            <textarea
              :id="`command-${scope.key}-ids`"
              :ref="
                (el) => {
                  if (scope.key === 'group') groupInput = el as HTMLTextAreaElement
                  else privateInput = el as HTMLTextAreaElement
                }
              "
              v-model="draft[scope.key]"
              rows="7"
              style="resize: none"
              :disabled="busy"
              :aria-invalid="invalid === scope.key"
              :aria-describedby="`command-${scope.key}-hint command-policy-error`"
            />
            <p :id="`command-${scope.key}-hint`" class="im-hint">
              {{
                draft[scope.mode] === 'whitelist'
                  ? '仅允许名单内的聊天；留空禁止所有。'
                  : '禁止名单内的聊天；留空允许所有。'
              }}
            </p>
          </section>
        </div>
      </template>
      <p id="command-policy-error" class="im-error" :role="message ? 'alert' : undefined">
        {{ message }}
      </p>
      <button v-if="message || (!loaded && !busy)" type="button" :disabled="busy" @click="reload">
        重新读取权限
      </button>
    </form>
    <template #footer
      ><button :disabled="busy" @click="close">取消</button
      ><button
        form="command-policy-form"
        type="submit"
        class="im-primary"
        :disabled="busy || !loaded"
      >
        {{ busy ? '处理中…' : '保存权限' }}
      </button></template
    >
  </EditorDialog>
</template>
