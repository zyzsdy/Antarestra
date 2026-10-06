<script setup lang="ts">
import SchemaValue from './SchemaValue.vue'
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
</script>
<template>
  <div class="schema-fields">
    <p v-if="!fields.length">此插件没有可编辑的表单配置项。</p>
    <div v-for="[key, field] in fields" :key="key" class="schema-field">
      <template
        v-if="
          field.type === 'object' &&
          field.properties &&
          !field.additionalProperties &&
          !field['x-ai-model']
        "
      >
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
        <SchemaValue
          :field="field"
          :value="value[key]"
          :id="`${prefix ?? 'config'}-${key}`"
          :label="field.title ?? key"
          @change="(item, remove) => emit('change', [key], item, remove)"
        />
        <small v-if="field.description">{{ field.description }}</small>
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
}
</style>
