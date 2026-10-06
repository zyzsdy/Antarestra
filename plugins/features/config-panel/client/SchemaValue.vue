<script setup lang="ts">
import { SecretInput, SelectField } from '@antarestra/webui/components'
import type { Schema } from './types.js'
import SchemaForm from './SchemaForm.vue'
import SchemaCollection from './SchemaCollection.vue'
import SchemaModel from './SchemaModel.vue'
const props = defineProps<{
  field: Schema
  value: unknown
  id: string
  label: string
  compact?: boolean
}>()
const emit = defineEmits<{ change: [value: unknown, remove?: boolean] }>()
function nested(path: string[], item: unknown, remove = false) {
  const result = structuredClone(
    props.value && typeof props.value === 'object' ? JSON.parse(JSON.stringify(props.value)) : {},
  ) as Record<string, unknown>
  let parent = result
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== 'object')
      Object.defineProperty(parent, key, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      })
    parent = parent[key] as Record<string, unknown>
  }
  const key = path.at(-1)!
  if (remove) delete parent[key]
  else
    Object.defineProperty(parent, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  emit('change', result)
}
function input(raw: string) {
  const field = props.field
  let value: unknown = raw
  if (!raw.startsWith('$')) {
    if (field.type === 'boolean' && ['true', 'false'].includes(raw)) value = raw === 'true'
    if (
      ['integer', 'number'].includes(field.type ?? '') &&
      raw.trim() &&
      Number.isFinite(Number(raw))
    )
      value = Number(raw)
    if (!field.type || field.type === 'array' || field.type === 'object') {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
  }
  emit('change', value)
}
function display(value: unknown) {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
}
function sensitive(field: Schema) {
  return field['x-sensitive'] || field.format === 'password'
}
</script>
<template>
  <SchemaModel
    v-if="!sensitive(field) && field['x-ai-model'] && field.type === 'object'"
    :field="field"
    :value="value"
    :id="id"
    :label="label"
    @change="(item, remove) => emit('change', item, remove)"
  />
  <SchemaCollection
    v-else-if="
      !sensitive(field) &&
      (field.type === 'array' || (field.type === 'object' && !field.properties)) &&
      typeof value !== 'string'
    "
    :field="field"
    :value="value"
    :id="id"
    :label="label"
    @change="(item, remove) => emit('change', item, remove)"
  />
  <SchemaForm
    v-else-if="field.type === 'object' && field.properties && typeof value !== 'string'"
    :schema="field"
    :value="(value ?? {}) as Record<string, unknown>"
    :prefix="id"
    @change="nested"
  />
  <template v-else>
    <div class="field-input">
      <SelectField
        v-if="!sensitive(field) && (field.enum || field.type === 'boolean')"
        :id="id"
        :label="label"
        :aria-label="label"
        :model-value="String(value ?? '')"
        :options="
          (field.enum ?? [true, false]).map((option) => ({
            id: String(option),
            name: String(option),
          }))
        "
        :placeholder="
          field.default === undefined ? '未设置' : `默认：${JSON.stringify(field.default)}`
        "
        editable
        autocomplete="off"
        empty-text="没有匹配选项，可保留手动输入的值或 $环境变量。"
        @update:model-value="input($event)"
      />
      <SecretInput
        v-else-if="sensitive(field)"
        :id="id"
        :label="label"
        :aria-label="label"
        :model-value="display(value)"
        :placeholder="
          field.default === undefined ? '未设置' : '默认：' + JSON.stringify(field.default)
        "
        autocomplete="new-password"
        @update:model-value="input($event)"
      />
      <input
        v-else
        :id="id"
        type="text"
        :aria-label="label"
        :value="display(value)"
        :placeholder="
          field.default === undefined ? '未设置' : `默认：${JSON.stringify(field.default)}`
        "
        :autocomplete="field['x-sensitive'] ? 'new-password' : 'off'"
        @input="input(($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        :aria-label="`移除 ${label}`"
        :title="`重置 ${label}`"
        :class="{ compact }"
        @click="emit('change', undefined, true)"
      >
        {{ compact ? '×' : '重置' }}
      </button>
    </div>

    <button
      v-if="['object', 'array'].includes(field.type ?? '')"
      type="button"
      @click="emit('change', field.type === 'array' ? [] : {})"
    >
      改为表格
    </button>
  </template>
</template>
<style scoped>
.field-input {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.field-input input,
.field-input .ui-select,
.field-input .ui-secret-input {
  min-width: 0;
  flex: 1;
  width: 100%;
}
.field-input > button {
  flex: none;
}
.field-input > button.compact {
  padding: 6px;
  width: 30px;
}
</style>
