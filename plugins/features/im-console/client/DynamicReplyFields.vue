<script setup lang="ts">
import { NumberField } from '@antarestra/webui/components'
import type { DynamicReplyPolicy } from '@antarestra/im'
import { dynamicReplyDefaults, invalidDynamicReplyField } from '@antarestra/im/activation'

defineProps<{ id: string; busy: boolean }>()
const model = defineModel<DynamicReplyPolicy>({ required: true })
const fields = [
  { key: 'baseProbability', label: '基础激活概率（%）', scale: 100, min: 0, max: 100, step: 0.1 },
  { key: 'hotProbability', label: '热点初始概率（%）', scale: 100, min: 0, max: 100, step: 0.1 },
  { key: 'hotDurationMs', label: '热点持续时间（秒）', scale: 0.001, min: 1, max: 3600, step: 1 },
  { key: 'maxSilentMessages', label: '必定激活阈值（条）', scale: 1, min: 1, max: 100000, step: 1 },
] as const
</script>
<template>
  <div>
    <div class="im-grid">
      <label v-for="field in fields" :key="field.key" :for="`${id}-${field.key}`">
        {{ field.label }}
        <NumberField
          :id="`${id}-${field.key}`"
          :model-value="(model[field.key] ?? dynamicReplyDefaults[field.key]) * field.scale"
          :min="field.min"
          :max="field.max"
          :step="field.step"
          :disabled="busy"
          :aria-describedby="
            invalidDynamicReplyField(model) === field.key
              ? `${id}-dynamic-help ${id}-${field.key}-error`
              : `${id}-dynamic-help`
          "
          :aria-invalid="invalidDynamicReplyField(model) === field.key"
          @update:model-value="model[field.key] = $event / field.scale"
        />
        <span
          v-if="invalidDynamicReplyField(model) === field.key"
          :id="`${id}-${field.key}-error`"
          class="im-error"
          role="alert"
        >
          请输入 {{ field.min }} 至 {{ field.max }} 之间的{{ field.step === 1 ? '整数' : '数值' }}。
        </span>
      </label>
    </div>
    <p :id="`${id}-dynamic-help`" class="im-hint">
      激活后暂时更爱接话，热度逐渐消退，窗口内回复不延长热点。连续未激活的有效群聊文本越多，
      概率越高，前期缓慢、临近阈值加速，达到阈值的那条消息必定命中动态条件。
      冷却、限流和队列限制仍有效；主动发送不计数、不改变热度。
    </p>
  </div>
</template>
