<script setup lang="ts">
import { computed } from 'vue'
import { NumberField, CheckboxField } from '@antarestra/webui/components'
import { invalidHistoryField } from '@antarestra/im/activation'
import type { ChatPolicy } from '@antarestra/im'
const props = defineProps<{ id: string; busy: boolean; privateChat?: boolean }>()
const model = defineModel<ChatPolicy>({ required: true })
const template = computed({
  get: () => model.value.userInputTemplate ?? '',
  set: (value: string) => {
    model.value.userInputTemplate = value
  },
})
const fields = [
  {
    key: 'historyLimit',
    label: '未读消息最多条数',
    value: 50,
    max: 200,
    hint: '只取最近的消息；不附加历史时使用 last_message 模板。',
  },
  {
    key: 'maxImages',
    label: '每次请求最多图片数',
    value: 5,
    max: 20,
    hint: '优先附上最新图片，较早图片仅保留标签；0 表示全部只用标签。',
  },
  {
    key: 'maxFiles',
    label: '每次请求最多文件数',
    value: 5,
    max: 20,
    hint: '包括视频、音频和其他文件，优先附上最新内容。',
  },
  {
    key: 'mediaRetentionDays',
    label: '群媒体保留天数',
    value: 7,
    max: 36500,
    hint: '0 表示不按时间清理；文本与消息元数据永久保留。',
  },
  {
    key: 'mediaMaxBytes',
    label: '群媒体总大小上限（MiB）',
    value: 0,
    max: 8589934591,
    hint: '按当前工作空间计算；0 表示不限。超出后清理最旧媒体，不删除手动上传文件。',
  },
  {
    key: 'queueLimit',
    label: '最多等待请求数',
    value: 5,
    max: 100,
    hint: '同一工作空间共享等待队列。',
  },
] as const
type Key = (typeof fields)[number]['key']
const visibleFields = computed(() =>
  fields.filter(
    (field) =>
      !props.privateChat ||
      !['historyLimit', 'mediaRetentionDays', 'mediaMaxBytes'].includes(field.key),
  ),
)
function setNumber(key: Key, value: number) {
  model.value[key] = key === 'mediaMaxBytes' ? value * 1024 ** 2 : value
}
function setOverride(key: Key, enabled: boolean, value: number) {
  if (enabled) setNumber(key, value)
  else delete model.value[key]
}
</script>
<template>
  <div class="im-policy-fields">
    <label :for="`${id}-user-input`"
      >AI 用户输入模板
      <textarea
        :id="`${id}-user-input`"
        class="resize-none"
        v-model="template"
        :disabled="busy"
        rows="4"
        placeholder="留空继承；群聊默认未读消息与激活原因，私聊默认 {{last_message}}"
        :aria-describedby="`${id}-template-help`"
      />
    </label>
    <p :id="`${id}-template-help`" class="im-hint">
      <code v-pre>{{ history_message }}</code> 为上次激活后尚未读取的群消息（不包含本次消息）；
      <code v-pre>{{ last_message }}</code> 为本次触发消息；<code v-pre>{{ active_reason }}</code>
      为激活原因。 仅需最后一条时填写 <code v-pre>{{ last_message }}</code
      >。附件合计最多 20 个，单个最多 16
      MiB，并受所选模型能力限制；超限、已过期或无法读取的媒体保留类型与 ID 标签。
    </p>
    <div class="im-grid">
      <div v-for="field in visibleFields" :key="field.key">
        <label class="im-check"
          ><CheckboxField
            :checked="model[field.key] !== undefined"
            :disabled="busy"
            @change="setOverride(field.key, $event, field.value)"
          />自定义{{ field.label }}</label
        >
        <label v-if="model[field.key] !== undefined" :for="`${props.id}-${field.key}`"
          >{{ field.label }}
          <NumberField
            :id="`${props.id}-${field.key}`"
            :model-value="
              field.key === 'mediaMaxBytes' ? model[field.key]! / 1024 ** 2 : model[field.key]!
            "
            :aria-invalid="invalidHistoryField(model) === field.key"
            :aria-describedby="`${props.id}-${field.key}-help`"
            :min="field.key === 'queueLimit' || field.key === 'historyLimit' ? 1 : 0"
            :max="field.max"
            :disabled="busy"
            @update:model-value="setNumber(field.key, $event)"
          />
        </label>
        <p v-if="invalidHistoryField(model) === field.key" class="im-error" role="alert">
          请输入允许范围内的整数。
        </p>
        <p :id="`${props.id}-${field.key}-help`" class="im-hint">
          {{ model[field.key] === undefined ? `继承上级；系统默认 ${field.value}。` : ''
          }}{{ field.hint }}
        </p>
      </div>
    </div>
  </div>
</template>
<style scoped>
.resize-none {
  resize: none;
}
</style>
