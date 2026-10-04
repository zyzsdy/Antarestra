<script setup lang="ts">
import { computed } from 'vue'
import { CheckboxField, NumberField, SelectField } from '@antarestra/webui/components'
import type { ChatPolicy } from '@antarestra/im'
import { dynamicReplyDefaults } from '@antarestra/im/activation'
import DynamicReplyFields from './DynamicReplyFields.vue'
import HistoryFields from './HistoryFields.vue'
const props = defineProps<{ id: string; busy: boolean; privateChat?: boolean }>()
const model = defineModel<ChatPolicy>({ required: true })
const choices = [
  { id: 'inherit', name: '继承默认值' },
  { id: 'on', name: '启用' },
  { id: 'off', name: '关闭' },
]
function getFlag(key: 'enabled' | 'commands' | 'ai' | 'appendReplyFormat') {
  return model.value[key] === undefined ? 'inherit' : model.value[key] ? 'on' : 'off'
}
function setFlag(key: 'enabled' | 'commands' | 'ai' | 'appendReplyFormat', value: string) {
  if (value === 'inherit') delete model.value[key]
  else model.value[key] = value === 'on'
}
const agent = computed({
  get: () => model.value.agentId ?? '',
  set: (value: string) => {
    if (value.trim()) model.value.agentId = value.trim()
    else delete model.value.agentId
  },
})
const flags = [
  { key: 'enabled', label: '机器人' },
  { key: 'commands', label: '普通命令' },
  { key: 'ai', label: 'AI 回复' },
] as const
function customActivation(value: boolean) {
  if (value)
    model.value.activation = {
      mode: 'any',
      mention: true,
      prefixes: ['/ai'],
      cooldownMs: 0,
      maxPerMinute: 20,
    }
  else delete model.value.activation
}
function setDynamic(enabled: boolean) {
  if (!model.value.activation) return
  if (enabled) model.value.activation.dynamic = { ...dynamicReplyDefaults }
  else delete model.value.activation.dynamic
}
</script>
<template>
  <div class="im-policy-fields">
    <div class="im-grid">
      <label v-for="flag in flags" :key="flag.key" :for="`${props.id}-${flag.key}`"
        >{{ flag.label }}
        <SelectField
          :id="`${props.id}-${flag.key}`"
          :label="flag.label"
          :options="choices"
          :model-value="getFlag(flag.key)"
          :disabled="busy"
          @update:model-value="setFlag(flag.key, $event)"
        />
      </label>
      <label :for="`${id}-agent`"
        >Agent ID<input
          :id="`${id}-agent`"
          v-model="agent"
          placeholder="留空继承；默认使用系统助理"
          :disabled="busy"
          autocomplete="off"
      /></label>
    </div>
    <label :for="`${id}-reply-format`">
      自动追加回复格式指引
      <SelectField
        :id="`${id}-reply-format`"
        label="自动追加回复格式指引"
        :options="choices"
        :model-value="getFlag('appendReplyFormat')"
        :disabled="busy"
        @update:model-value="setFlag('appendReplyFormat', $event)"
      />
    </label>
    <p class="im-hint">
      系统默认关闭。启用后，在系统提示词末尾追加分条消息、引用和图片的格式说明。
      也可在系统提示词任意位置插入 <code v-text="'{{im_reply_format}}'"></code>，不受此开关影响；
      已插入变量时不会重复追加。表情包按图片发送，具体支持取决于接入平台。
    </p>
    <HistoryFields v-model="model" :id="id" :busy="busy" :private-chat="privateChat" />
    <label class="im-check"
      ><CheckboxField
        :checked="!!model.activation"
        :disabled="busy"
        @change="customActivation"
      />自定义 AI 激活条件</label
    >
    <div v-if="model.activation" class="im-activation">
      <p class="im-hint">
        未自定义时继承上级规则；系统默认私聊每条激活，群聊仅 @机器人或 /ai 前缀。
      </p>
      <div class="im-grid">
        <label class="im-check"
          ><CheckboxField v-model="model.activation.always" :disabled="busy" />每条消息</label
        >
        <label class="im-check"
          ><CheckboxField v-model="model.activation.mention" :disabled="busy" />@当前机器人</label
        >
        <label class="im-check"
          ><CheckboxField v-model="model.activation.reply" :disabled="busy" />回复当前机器人</label
        >
        <label :for="`${id}-mode`"
          >组合方式<SelectField
            :id="`${id}-mode`"
            label="激活组合方式"
            :options="[
              { id: 'any', name: '任意条件满足' },
              { id: 'all', name: '全部条件满足' },
            ]"
            :model-value="model.activation.mode ?? 'any'"
            :disabled="busy"
            @update:model-value="model.activation.mode = $event as 'any' | 'all'"
        /></label>
        <label :for="`${id}-prefix`"
          >消息前缀（每行一个）<textarea
            :id="`${id}-prefix`"
            :value="model.activation.prefixes?.join('\n') ?? ''"
            rows="2"
            :disabled="busy"
            @input="
              model.activation.prefixes = ($event.target as HTMLTextAreaElement).value.split(
                /\r?\n/,
              )
            "
          />
        </label>
        <label :for="`${id}-keywords`"
          >关键词（每行一个）<textarea
            :id="`${id}-keywords`"
            :value="model.activation.keywords?.join('\n') ?? ''"
            rows="2"
            :disabled="busy"
            @input="
              model.activation.keywords = ($event.target as HTMLTextAreaElement).value.split(
                /\r?\n/,
              )
            "
          />
        </label>
        <label :for="`${id}-cooldown`"
          >冷却时间（毫秒）<NumberField
            :id="`${id}-cooldown`"
            :model-value="model.activation.cooldownMs ?? 0"
            :min="0"
            :max="3600000"
            :disabled="busy"
            @update:model-value="model.activation.cooldownMs = $event"
        /></label>
        <label :for="`${id}-rate`"
          >每分钟最多激活次数<NumberField
            :id="`${id}-rate`"
            :model-value="model.activation.maxPerMinute ?? 20"
            :min="1"
            :max="1000"
            :disabled="busy"
            @update:model-value="model.activation.maxPerMinute = $event"
        /></label>
      </div>
      <label class="im-check">
        <CheckboxField
          :checked="!!model.activation.dynamic"
          :disabled="busy"
          @change="setDynamic"
        />动态回复（仅群聊）
      </label>
      <p class="im-hint">
        动态回复与上方条件独立并用，任一命中即可激活；上方“全部条件满足”只作用于普通条件。
      </p>
      <DynamicReplyFields
        v-if="model.activation.dynamic"
        v-model="model.activation.dynamic"
        :id="id"
        :busy="busy"
      />
    </div>
  </div>
</template>
