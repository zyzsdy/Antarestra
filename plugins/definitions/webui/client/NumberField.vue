<script setup lang="ts">
import { NumberFieldRoot, NumberFieldInput } from 'reka-ui'
defineOptions({ inheritAttrs: false })
defineProps<{
  id: string
  modelValue: number
  min: number
  max?: number
  step?: number
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
</script>
<template>
  <NumberFieldRoot
    :id="id"
    :model-value="modelValue"
    :min="min"
    :disabled="disabled"
    v-bind="max === undefined ? {} : { max }"
    :step="step ?? 1"
    locale="zh-CN"
    disable-wheel-change
    :format-options="{ useGrouping: false }"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <NumberFieldInput v-bind="$attrs" />
  </NumberFieldRoot>
</template>
