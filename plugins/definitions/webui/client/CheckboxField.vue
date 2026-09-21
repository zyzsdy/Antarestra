<script setup lang="ts" generic="T extends boolean | string[] = boolean">
import { computed } from 'vue'
import { CheckboxRoot, CheckboxIndicator } from 'reka-ui'
import { CheckIcon, MinusIcon } from '../src/icons.js'
const props = defineProps<{
  modelValue?: T | undefined
  checked?: boolean | undefined
  indeterminate?: boolean | undefined
  value?: string | undefined
  disabled?: boolean | undefined
}>()
const emit = defineEmits<{
  'update:modelValue': [value: T]
  change: [value: boolean]
}>()
const state = computed(() =>
  props.indeterminate
    ? 'indeterminate'
    : Array.isArray(props.modelValue)
      ? props.modelValue.includes(props.value ?? '')
      : (props.modelValue ?? props.checked ?? false),
)
function update(value: boolean | 'indeterminate') {
  const checked = value === true
  if (Array.isArray(props.modelValue)) {
    const item = props.value ?? ''
    emit(
      'update:modelValue',
      (checked
        ? [...new Set([...props.modelValue, item])]
        : props.modelValue.filter((v) => v !== item)) as T,
    )
  } else emit('update:modelValue', checked as T)
  emit('change', checked)
}
</script>
<template>
  <CheckboxRoot
    class="ui-checkbox"
    :model-value="state"
    :disabled="disabled"
    :value="value ?? 'on'"
    @update:model-value="update"
  >
    <CheckboxIndicator class="ui-checkbox-indicator">
      <MinusIcon v-if="indeterminate" aria-hidden="true" /><CheckIcon v-else aria-hidden="true" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
<style>
.ui-checkbox.ui-checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  flex: 0 0 18px;
  width: 18px;
  min-width: 18px;
  height: 18px;
  min-height: 18px;
  margin: 2px 6px 2px 0;
  padding: 0;
  border: 1px solid #9aabc7;
  border-radius: 4px;
  background: white;
  color: white;
}
.ui-checkbox.ui-checkbox[data-state='checked'],
.ui-checkbox.ui-checkbox[data-state='indeterminate'],
.ui-checkbox.ui-checkbox[data-state='checked']:hover:not(:disabled),
.ui-checkbox.ui-checkbox[data-state='indeterminate']:hover:not(:disabled) {
  background: #315ed1;
  border-color: #315ed1;
}
.ui-checkbox.ui-checkbox:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-checkbox-indicator,
.ui-checkbox-indicator svg {
  display: block;
  width: 14px;
  height: 14px;
}
</style>
