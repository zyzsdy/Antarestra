<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { SelectField } from '@antarestra/webui/components'
import { useApi } from '@antarestra/webui/api'
import type { Schema } from './types.js'
const props = defineProps<{ field: Schema; value: unknown; id: string; label: string }>()
const emit = defineEmits<{ change: [value: unknown, remove?: boolean] }>()
interface Provider {
  id: string
  title: string
  models: { id: string; title: string; thinkingLevels: string[] }[]
}
const { api, run, busy, message } = useApi()
const providers = ref<Provider[]>([])
const selection = computed(() =>
  props.value && typeof props.value === 'object' ? (props.value as Record<string, unknown>) : {},
)
const providerId = computed(() => String(selection.value.providerId ?? ''))
const modelId = computed(() => String(selection.value.modelId ?? ''))
const models = computed(() => providers.value.find((p) => p.id === providerId.value)?.models ?? [])
const levels = computed(
  () => models.value.find((m) => m.id === modelId.value)?.thinkingLevels ?? [],
)
function options(items: { id: string; name: string }[], current: string) {
  return current && !items.some((item) => item.id === current)
    ? [{ id: current, name: `${current}（当前配置，目录不可用）`, disabled: true }, ...items]
    : items
}
const thinkingLabels: Record<string, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}
function change(key: string, value: string) {
  const next = { ...selection.value, [key]: value }
  if (key === 'providerId' && value !== providerId.value) {
    delete next.modelId
    delete next.thinking
  }
  if (key === 'modelId' && value !== modelId.value) delete next.thinking
  if (key === 'thinking' && !value) delete next.thinking
  emit('change', next)
}
function load() {
  return run(async () => {
    providers.value = (
      await api<{ providers: Provider[] }>('/plugin-config-panel/ai-models')
    ).providers
  })
}
onMounted(load)
</script>
<template>
  <div class="model-fields">
    <template v-if="typeof value !== 'string'">
      <label :for="id">提供商</label>
      <SelectField
        :id="id"
        :label="`${label}提供商`"
        :model-value="providerId"
        :options="
          options(
            providers.map((p) => ({ id: p.id, name: p.title })),
            providerId,
          )
        "
        searchable
        placeholder="选择提供商"
        empty-text="没有可用提供商"
        :disabled="busy"
        @update:model-value="change('providerId', $event)"
      />
      <label :for="`${id}-model`">模型</label>
      <SelectField
        :id="`${id}-model`"
        :label="`${label}模型`"
        :model-value="modelId"
        :options="
          options(
            models.map((m) => ({ id: m.id, name: m.title })),
            modelId,
          )
        "
        searchable
        placeholder="选择模型"
        empty-text="此提供商没有可用模型"
        :disabled="busy || !providerId"
        @update:model-value="change('modelId', $event)"
      />
      <template v-if="field.properties?.thinking">
        <label :for="`${id}-thinking`">思考强度</label>
        <SelectField
          :id="`${id}-thinking`"
          :label="`${label}思考强度`"
          :model-value="String(selection.thinking ?? '')"
          :options="
            options(
              [
                { id: '', name: '模型默认' },
                ...levels.map((id) => ({ id, name: thinkingLabels[id] ?? id })),
              ],
              String(selection.thinking ?? ''),
            )
          "
          :disabled="busy || !modelId"
          @update:model-value="change('thinking', $event)"
        />
      </template>
      <small v-if="modelId && !models.some((m) => m.id === modelId)" role="status"
        >当前模型未出现在目录中，已保留原配置。</small
      >
    </template>
    <template v-else>
      <input
        :id="id"
        :aria-label="label"
        :value="value"
        @input="emit('change', ($event.target as HTMLInputElement).value)"
      />
      <button type="button" @click="emit('change', {})">改为模型选择</button>
    </template>
    <small v-if="busy" role="status">正在加载模型目录…</small>
    <small v-if="message" role="alert">{{ message }}；可重试或通过 YAML 编辑配置。</small>
    <div class="model-actions">
      <button type="button" :disabled="busy" @click="load">刷新目录</button>
      <button type="button" @click="emit('change', undefined, true)">重置</button>
      <button v-if="typeof value !== 'string'" type="button" @click="emit('change', '$')">
        使用环境变量
      </button>
    </div>
  </div>
</template>
<style scoped>
.model-fields {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.model-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
small {
  overflow-wrap: anywhere;
}
</style>
