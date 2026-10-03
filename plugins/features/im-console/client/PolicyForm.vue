<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { CheckboxField, SelectField } from '@antarestra/webui/components'
import type { ChatPolicy, ConnectionPolicy } from '@antarestra/im'
import { invalidDynamicReplyField, invalidHistoryField } from '@antarestra/im/activation'
import ChatPolicyFields from './ChatPolicyFields.vue'
const props = defineProps<{ policy: ConnectionPolicy; busy: boolean }>()
const emit = defineEmits<{ dirty: []; save: [policy: ConnectionPolicy] }>()
const draft = reactive(JSON.parse(JSON.stringify(props.policy)) as ConnectionPolicy)
draft.private ??= { mode: 'whitelist', ids: [] }
draft.group ??= { mode: 'whitelist', ids: [] }
draft.defaults ??= {}
draft.private.defaults ??= {}
draft.group.defaults ??= {}
draft.chats ??= {}
const groups = [
  { key: 'group', label: '群聊' },
  { key: 'private', label: '私聊' },
] as const
const modes = [
  { id: 'whitelist', name: '白名单：仅允许名单内聊天' },
  { id: 'blacklist', name: '黑名单：允许名单外聊天' },
]
const targetType = ref('group')
const targetId = ref('')
const error = ref('')
const form = ref<HTMLFormElement>()
watch(draft, () => emit('dirty'), { deep: true })
function add() {
  const id = targetId.value.trim()
  if (!id || /\s/.test(id) || id.length > 200) {
    error.value = '请输入不含空白的群号或用户 ID。'
    return
  }
  const key = `${targetType.value}:${id}`
  if (draft.chats![key]) {
    error.value = '该聊天已有单独规则，请在下方编辑。'
    return
  }
  if (Object.keys(draft.chats!).length >= 100) {
    error.value = '单个接入最多配置 100 条单独规则。'
    return
  }
  draft.chats![key] = {}
  targetId.value = ''
  error.value = ''
}
async function save() {
  error.value = ''
  for (const scope of [
    draft.defaults,
    draft.group?.defaults,
    draft.private?.defaults,
    ...Object.values(draft.chats ?? {}),
  ]) {
    if (scope && invalidHistoryField(scope)) {
      error.value = '请修正消息与媒体参数后保存。'
      await nextTick()
      form.value?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
      return
    }
    if (!scope?.activation) continue
    const activation = scope.activation
    if (activation.dynamic && invalidDynamicReplyField(activation.dynamic)) {
      error.value = '请修正动态回复参数后保存。'
      await nextTick()
      form.value?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
      return
    }
    if (
      !activation.always &&
      !activation.mention &&
      !activation.reply &&
      !activation.dynamic &&
      !activation.prefixes?.length &&
      !activation.keywords?.length
    ) {
      error.value = '自定义激活条件至少选择一种；关闭 AI 请使用“AI 回复：关闭”。'
      return
    }
  }
  emit('save', JSON.parse(JSON.stringify(draft)) as ConnectionPolicy)
}
function updateDefaults(type: 'private' | 'group', value: ChatPolicy) {
  draft[type]!.defaults = value
}
</script>
<template>
  <form
    ref="form"
    id="im-policy-form"
    class="im-form"
    novalidate
    autocomplete="off"
    @submit.prevent="save"
  >
    <fieldset :disabled="busy">
      <p class="im-hint">
        名单先决定是否准入，再依次合并接入默认、聊天类型默认和单独规则。适配器准入上限始终有效。
      </p>
      <label class="im-check"
        ><CheckboxField
          :checked="draft.enabled !== false"
          :disabled="busy"
          @change="draft.enabled = $event"
        />启用此接入的消息处理</label
      >
      <section class="im-form-section">
        <h3>接入默认规则</h3>
        <ChatPolicyFields v-model="draft.defaults!" id="im-default" :busy="busy" />
      </section>
      <section v-for="scope in groups" :key="scope.key" class="im-form-section">
        <h3>{{ scope.label }}准入与默认规则</h3>
        <label :for="`im-${scope.key}-access`"
          >准入模式<SelectField
            :id="`im-${scope.key}-access`"
            :label="`${scope.label}准入模式`"
            :options="modes"
            :model-value="draft[scope.key]!.mode"
            :disabled="busy"
            @update:model-value="draft[scope.key]!.mode = $event as 'whitelist' | 'blacklist'"
        /></label>
        <label :for="`im-${scope.key}-ids`"
          >{{ scope.label === '群聊' ? '群号' : '用户 ID' }}（每行一个）<textarea
            :id="`im-${scope.key}-ids`"
            :value="draft[scope.key]!.ids.join('\n')"
            rows="3"
            :disabled="busy"
            @input="
              draft[scope.key]!.ids = [
                ...new Set(
                  ($event.target as HTMLTextAreaElement).value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                ),
              ]
            "
          />
        </label>
        <p class="im-hint">
          白名单留空表示全部禁止；黑名单留空表示全部允许，但仍受适配器准入上限限制。
        </p>
        <ChatPolicyFields
          :model-value="draft[scope.key]!.defaults ?? {}"
          :id="`im-${scope.key}`"
          :private-chat="scope.key === 'private'"
          :busy="busy"
          @update:model-value="updateDefaults(scope.key, $event)"
        />
      </section>
      <section class="im-form-section">
        <h3>指定聊天的单独规则</h3>
        <p class="im-hint">单独规则不能绕过准入名单。留空字段继承上级；移除单独规则后恢复继承。</p>
        <div class="im-toolbar">
          <SelectField
            v-model="targetType"
            label="聊天类型"
            :options="[
              { id: 'group', name: '群聊' },
              { id: 'private', name: '私聊' },
            ]"
            :disabled="busy"
          /><label for="im-new-target"
            >聊天 ID<input
              id="im-new-target"
              v-model="targetId"
              placeholder="群号或用户 ID"
              :disabled="busy" /></label
          ><button type="button" :disabled="busy" @click="add">添加规则</button>
        </div>
        <section v-for="(value, key) in draft.chats" :key="key" class="im-override">
          <div class="im-toolbar">
            <h4>
              {{ key.startsWith('group:') ? '群聊' : '私聊' }} {{ key.slice(key.indexOf(':') + 1) }}
            </h4>
            <button type="button" :disabled="busy" @click="delete draft.chats![key]">
              移除单独规则
            </button>
          </div>
          <ChatPolicyFields
            :model-value="value"
            :id="`im-chat-${key}`"
            :private-chat="key.startsWith('private:')"
            :busy="busy"
            @update:model-value="draft.chats![key] = $event"
          />
        </section>
        <p v-if="!Object.keys(draft.chats!).length" class="im-hint">暂无单独规则。</p>
      </section>
      <p v-if="error" class="im-error" role="alert">{{ error }}</p>
    </fieldset>
  </form>
</template>
