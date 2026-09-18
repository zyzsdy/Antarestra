<script setup lang="ts">
import { computed, ref } from 'vue'
import { SelectField } from '@antarestra/webui/components'
import type { Schema } from './types.js'
const props = defineProps<{ schema: Schema; value: Record<string, unknown>; prefix?: string }>()
const emit = defineEmits<{ change: [path: string[], value: unknown, remove?: boolean] }>()
const visible = ref<Record<string, boolean>>({})
const fields = computed(() =>
  Object.entries(props.schema.properties ?? {}).sort(
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
    if (field.type === 'array') {
      try {
        value = JSON.parse(raw)
      } catch {
        value = raw
      }
    }
  }
  emit('change', [key], value)
}
</script>
<template>
  <div class="schema-fields">
    <p v-if="!Object.keys(schema.properties ?? {}).length">此插件没有可编辑的表单配置项。</p>
    <div v-for="[key, field] in fields" :key="key" class="schema-field">
      <template v-if="field.type === 'object' && field.properties">
        <fieldset>
          <legend>{{ field.title ?? key }}</legend>
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
            v-if="!field['x-sensitive'] && (field.enum || field.type === 'boolean')"
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
            empty-text="没有匹配选项，可保留手动输入的值或 $环境变量。"
            @update:model-value="input(key, field, $event)"
          />
          <input
            v-else
            :id="`${prefix ?? 'config'}-${key}`"
            :type="field['x-sensitive'] && !visible[key] ? 'password' : 'text'"
            :value="Array.isArray(value[key]) ? JSON.stringify(value[key]) : (value[key] ?? '')"
            :placeholder="
              field.default === undefined ? '未设置' : `默认：${JSON.stringify(field.default)}`
            "
            autocomplete="off"
            @input="input(key, field, ($event.target as HTMLInputElement).value)"
          />
          <button
            v-if="field['x-sensitive']"
            type="button"
            :aria-label="visible[key] ? '隐藏敏感值' : '显示敏感值'"
            :aria-pressed="!!visible[key]"
            @click="visible[key] = !visible[key]"
          >
            {{ visible[key] ? '隐藏' : '显示' }}
          </button>
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
  display: grid;
  gap: 7px;
}
.field-input {
  display: flex;
  gap: 6px;
}
.field-input input,
.field-input .ui-select {
  min-width: 0;
  flex: 1;
}
small {
  color: #667085;
}
fieldset {
  border: 1px solid #e4e9f1;
  border-radius: 7px;
  padding: 16px;
}
</style>
