<script setup lang="ts">
import { SecretInput, SelectField } from '@antarestra/webui/components'
import { computed } from 'vue'
import type { Schema } from './types.js'
import { resolveFormSchema } from './types.js'
const props = defineProps<{ schema: Schema; value: Record<string, unknown>; prefix?: string }>()
const emit = defineEmits<{ change: [path: string[], value: unknown, remove?: boolean] }>()
const fields = computed(() =>
  Object.entries(resolveFormSchema(props.schema)?.properties ?? {}).sort(
    ([, a], [, b]) => (a['x-order'] ?? 0) - (b['x-order'] ?? 0),
  ),
)
function input(key: string, field: Schema, raw: string) {
  let value: unknown = raw
  if (!raw.startsWith('$')) {
    if (field.type === 'boolean' && ['true', 'false'].includes(raw)) value = raw === 'true'
    if (
      ['integer', 'number'].includes(field.type ?? '') &&
      raw.trim() &&
      Number.isFinite(Number(raw))
    )
      value = Number(raw)
    if (field.type === 'array' || field.type === 'object') {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
  }
  emit('change', [key], value)
}
function display(value: unknown) {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
}
function sensitive(field: Schema) {
  return field['x-sensitive'] || field.format === 'password'
}
</script>
<template>
  <div class="schema-fields">
    <p v-if="!fields.length">此插件没有可编辑的表单配置项。</p>
    <div v-for="[key, field] in fields" :key="key" class="schema-field">
      <template v-if="field.type === 'object' && field.properties && !field.additionalProperties">
        <fieldset>
          <legend>{{ field.title ?? key }}</legend>
          <small v-if="field.description">{{ field.description }}</small>
          <SchemaForm
            :schema="field"
            :prefix="`${prefix ?? 'config'}-${key}`"
            :value="
              (value[key] && typeof value[key] === 'object' ? value[key] : {}) as Record<
                string,
                unknown
              >
            "
            @change="(path, item, remove) => emit('change', [key, ...path], item, remove)"
          />
        </fieldset>
      </template>
      <template v-else>
        <label :for="`${prefix ?? 'config'}-${key}`"
          >{{ field.title ?? key }}
          <span v-if="schema.required?.includes(key)">（必填）</span></label
        >
        <div class="field-input">
          <SelectField
            v-if="!sensitive(field) && (field.enum || field.type === 'boolean')"
            :id="`${prefix ?? 'config'}-${key}`"
            :label="field.title ?? key"
            :model-value="String(value[key] ?? '')"
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
            @update:model-value="input(key, field, $event)"
          />
          <SecretInput
            v-else-if="sensitive(field)"
            :id="(prefix ?? 'config') + '-' + key"
            :label="field.title ?? key"
            :model-value="display(value[key])"
            :placeholder="
              field.default === undefined ? '未设置' : '默认：' + JSON.stringify(field.default)
            "
            autocomplete="new-password"
            @update:model-value="input(key, field, $event)"
          />
          <input
            v-else
            :id="`${prefix ?? 'config'}-${key}`"
            type="text"
            :value="display(value[key])"
            :placeholder="
              field.default === undefined ? '未设置' : `默认：${JSON.stringify(field.default)}`
            "
            :autocomplete="field['x-sensitive'] ? 'new-password' : 'off'"
            @input="input(key, field, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            :aria-label="`移除 ${field.title ?? key}`"
            @click="emit('change', [key], undefined, true)"
          >
            重置
          </button>
        </div>
        <small v-if="field.description">{{ field.description }}</small>
        <small v-if="field.type === 'array'"
          >使用 JSON 数组，例如 ["plugins"]；复杂内容可切换 YAML。</small
        >
        <small v-else-if="field.type === 'object'"
          >使用 JSON 对象，例如 {"key":"value"}；复杂内容可切换 YAML。</small
        >
        <small v-else-if="field.type === 'boolean'">填写 true、false 或 $环境变量名。</small>
      </template>
    </div>
  </div>
</template>
<style scoped>
.schema-fields {
  display: grid;
  gap: 20px;
}
.schema-field {
  min-width: 0;
  display: grid;
  gap: 7px;
}
.field-input {
  display: flex;
  gap: 6px;
}
.field-input input,
.field-input .ui-select,
.field-input .ui-secret-input {
  min-width: 0;
  flex: 1;
}
small {
  color: #667085;
}
fieldset {
  min-width: 0;
  border: 1px solid #e4e9f1;
  border-radius: 7px;
  padding: 16px;
}
@media (max-width: 760px) {
  fieldset {
    margin: 0;
    padding: 12px 6px;
  }
  .field-input {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .field-input > button {
    justify-self: end;
  }
}
</style>
