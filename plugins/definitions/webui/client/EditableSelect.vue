<script setup lang="ts">
import { ref } from 'vue'
import SelectField from './SelectField.vue'
defineProps<{
  options: { id: string; name: string }[]
  label: string
  disabled?: boolean
}>()
const value = defineModel<string>({ required: true })
const control = ref<InstanceType<typeof SelectField>>()
defineExpose({ focus: () => control.value?.focus() })
</script>
<template>
  <SelectField
    ref="control"
    v-model="value"
    :options="options.map((item) => ({ id: item.id, name: item.id, description: item.name }))"
    :label="label"
    :disabled="disabled"
    editable
    :maxlength="64"
    placeholder="输入角色 ID 或名称筛选"
    empty-text="没有匹配角色，可直接保存输入的 ID。"
  />
</template>
