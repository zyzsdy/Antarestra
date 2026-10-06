<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SchemaValue from './SchemaValue.vue'
import { orderedEntries, orderedRecord } from './form-values.js'
import type { Schema } from './types.js'
const props = defineProps<{ field: Schema; value: unknown; id: string; label: string }>()
const emit = defineEmits<{ change: [value: unknown, remove?: boolean] }>()
const error = ref('')
const array = computed(() => props.field.type === 'array')
const itemSchema = computed<Schema>(() =>
  array.value
    ? (props.field.items ?? {})
    : typeof props.field.additionalProperties === 'object'
      ? props.field.additionalProperties
      : {},
)
const columns = computed(() =>
  Object.entries(itemSchema.value.properties ?? {}).sort(
    ([, a], [, b]) => (a['x-order'] ?? 0) - (b['x-order'] ?? 0),
  ),
)
const rows = computed<[string, unknown][]>(() =>
  array.value
    ? Array.isArray(props.value)
      ? props.value.map((item, index) => [String(index), item])
      : []
    : props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? orderedEntries(props.value as Record<string, unknown>)
      : [],
)
let nextRowId = 0
const rowIds = ref<number[]>([])
watch(
  () => rows.value.length,
  (length) => {
    rowIds.value = Array.from({ length }, (_, index) => rowIds.value[index] ?? nextRowId++)
  },
  { immediate: true, flush: 'sync' },
)
function removeRow(index: number) {
  rowIds.value.splice(index, 1)
  save(rows.value.filter((_, i) => i !== index))
}
function save(entries: [string, unknown][]) {
  emit('change', array.value ? entries.map(([, value]) => value) : orderedRecord(entries))
}
function initial(schema: Schema): unknown {
  if (schema.default !== undefined) return JSON.parse(JSON.stringify(schema.default))
  if (schema.type === 'object') return {}
  if (schema.type === 'array') return []
  if (schema.type === 'boolean') return false
  if (schema.type === 'integer' || schema.type === 'number') return 0
  return ''
}
function add() {
  let key = '新键'
  let suffix = 2
  while (rows.value.some(([existing]) => existing === key)) key = `新键${suffix++}`
  save([...rows.value, [key, initial(itemSchema.value)]])
}
function rename(index: number, event: Event) {
  const input = event.target as HTMLInputElement
  const key = input.value
  const previous = rows.value[index]!
  if (!key.trim() || rows.value.some(([existing], i) => i !== index && existing === key)) {
    error.value = !key.trim()
      ? '键不能为空，已保留原键。'
      : '键已存在，已保留原键；请使用不同的键。'
    input.value = previous[0]
    return
  }
  error.value = ''
  save(rows.value.map((entry, i) => (i === index ? [key, entry[1]] : entry)))
}
function update(index: number, value: unknown, column?: string, remove = false) {
  const entries = rows.value.slice()
  const entry = entries[index]!
  if (column !== undefined) {
    const record = { ...(entry[1] && typeof entry[1] === 'object' ? entry[1] : {}) } as Record<
      string,
      unknown
    >
    if (remove) delete record[column]
    else
      Object.defineProperty(record, column, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    entries[index] = [entry[0], record]
  } else entries[index] = [entry[0], remove ? initial(itemSchema.value) : value]
  save(entries)
}
function move(index: number, offset: number) {
  const entries = rows.value.slice()
  const target = index + offset
  if (target < 0 || target >= entries.length) return
  ;[rowIds.value[index], rowIds.value[target]] = [rowIds.value[target]!, rowIds.value[index]!]
  ;[entries[index], entries[target]] = [entries[target]!, entries[index]!]
  save(entries)
}
function cell(value: unknown, key: string) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
}
</script>
<template>
  <div class="collection">
    <div class="collection-toolbar">
      <span>{{ rows.length }} 行</span>
      <button type="button" @click="add">添加行</button>
      <button type="button" @click="emit('change', '$')">使用环境变量</button>
      <button type="button" :aria-label="`移除 ${label}`" @click="emit('change', undefined, true)">
        重置
      </button>
    </div>
    <div class="collection-scroll" role="region" :aria-label="`${label}表格`" tabindex="0">
      <table>
        <caption class="sr-only">
          {{
            label
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ array ? '序号' : '键' }}</th>
            <template v-if="columns.length"
              ><th v-for="[key, field] in columns" :key="key" scope="col">
                {{ field.title ?? key
                }}<span v-if="itemSchema.required?.includes(key)">（必填）</span>
              </th></template
            >
            <th v-else scope="col">值</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td :colspan="(columns.length || 1) + 2" class="empty">
              暂无条目，点击“添加行”开始配置。
            </td>
          </tr>
          <tr v-for="([key, value], index) in rows" :key="array ? rowIds[index] : key">
            <td>
              <span v-if="array">{{ index + 1 }}</span
              ><input
                v-else
                :id="`${id}-key-${index}`"
                :value="key"
                :aria-label="`${label}第 ${index + 1} 行的键`"
                autocomplete="off"
                @change="rename(index, $event)"
              />
            </td>
            <template
              v-if="columns.length && value && typeof value === 'object' && !Array.isArray(value)"
              ><td v-for="[column, field] in columns" :key="column">
                <SchemaValue
                  :id="`${id}-${index}-${column}`"
                  :field="field"
                  compact
                  :label="`${label}第 ${index + 1} 行 ${field.title ?? column}`"
                  :value="cell(value, column)"
                  @change="(item, remove) => update(index, item, column, remove)"
                /><small v-if="field.description">{{ field.description }}</small>
              </td></template
            >
            <td v-else :colspan="columns.length || 1">
              <SchemaValue
                :id="`${id}-${index}-value`"
                :field="itemSchema"
                :label="`${label}第 ${index + 1} 行的值`"
                :value="value"
                @change="(item, remove) => update(index, item, undefined, remove)"
              />
            </td>
            <td>
              <div class="row-actions">
                <button
                  type="button"
                  :disabled="index === 0"
                  :aria-label="`上移第 ${index + 1} 行`"
                  title="上移"
                  @click="move(index, -1)"
                >
                  ↑</button
                ><button
                  type="button"
                  :disabled="index === rows.length - 1"
                  :aria-label="`下移第 ${index + 1} 行`"
                  title="下移"
                  @click="move(index, 1)"
                >
                  ↓</button
                ><button
                  type="button"
                  :aria-label="`删除第 ${index + 1} 行`"
                  @click="removeRow(index)"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="error" role="alert" class="collection-error">{{ error }}</p>
  </div>
</template>
<style scoped>
.collection {
  min-width: 0;
  display: grid;
  gap: 8px;
}
.collection-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.collection-toolbar > span {
  margin-right: auto;
  color: #667085;
}
.collection-scroll {
  overflow-x: auto;
  border: 1px solid #e4e9f1;
  border-radius: 7px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid #e4e9f1;
  vertical-align: top;
}
th {
  background: #f4f6fa;
  white-space: nowrap;
}
td {
  min-width: 220px;
}
td:first-child {
  min-width: 140px;
}
td:last-child {
  min-width: 136px;
}
tbody tr:last-child td {
  border-bottom: 0;
}
td > input {
  width: 100%;
  box-sizing: border-box;
}
.row-actions {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}
.row-actions button {
  padding: 8px;
  white-space: nowrap;
}
.empty {
  text-align: center;
  color: #667085;
  padding: 24px;
}
small {
  color: #667085;
}
.collection-error {
  color: #b42318;
  margin: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
