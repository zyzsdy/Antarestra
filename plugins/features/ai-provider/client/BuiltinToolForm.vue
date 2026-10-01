<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { CheckboxField, SelectField } from '@antarestra/webui/components'
import type { ModelDefinition, JsonObject } from '@antarestra/ai'
import type { BuiltinTool } from '../src/types.js'
const props = defineProps<{
  value?: BuiltinTool
  models: ModelDefinition[]
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ save: [value: BuiltinTool]; dirty: [value: boolean] }>()
const draft = reactive<BuiltinTool>(
  props.value
    ? (JSON.parse(JSON.stringify(props.value)) as BuiltinTool)
    : { name: 'web_search', type: 'web_search', modelIds: [], options: {}, enabled: true },
)
const options = ref(JSON.stringify(draft.options, null, 2))
const initial = JSON.stringify({ draft, options: options.value })
const validation = ref('')
const invalid = ref('')
watch(
  [draft, options],
  () => emit('dirty', JSON.stringify({ draft, options: options.value }) !== initial),
  { deep: true },
)
function save(event: Event) {
  validation.value = ''
  invalid.value = 'builtin-type'
  try {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(draft.type) ||
      ['function', 'custom'].includes(draft.type)
    )
      throw new Error('请输入有效的提供商内置工具类型，不能使用客户端 function 或 custom 类型。')
    invalid.value = 'builtin-name'
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(draft.name))
      throw new Error('工具名需为字母开头的 1–64 位字母、数字、下划线或短横线。')
    invalid.value = 'builtin-models'
    if (!draft.modelIds.length) throw new Error('请至少选择一个可用模型。')
    invalid.value = 'builtin-options'
    const parsed: unknown = options.value.trim() ? JSON.parse(options.value) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('工具选项需为 JSON 对象。')
    invalid.value = ''
    emit('save', { ...draft, modelIds: [...draft.modelIds], options: parsed as JsonObject })
  } catch (error) {
    validation.value = error instanceof Error ? error.message : '工具选项无效。'
    ;(event.target as HTMLFormElement).querySelector<HTMLElement>(`#${invalid.value}`)?.focus()
  }
}
</script>
<template>
  <form class="provider-form" novalidate @submit.prevent="save">
    <fieldset :disabled="busy">
      <label for="builtin-type">内置工具类型</label>
      <SelectField
        id="builtin-type"
        v-model="draft.type"
        label="内置工具类型"
        :aria-invalid="invalid === 'builtin-type'"
        aria-describedby="builtin-validation"
        :options="[
          { id: 'web_search', name: 'OpenAI Web Search' },
          { id: 'image_generation', name: 'OpenAI Image Generation' },
          { id: 'file_search', name: 'file_search' },
        ]"
        editable
        :disabled="busy"
      />
      <label for="builtin-name">工具名</label
      ><input
        id="builtin-name"
        v-model="draft.name"
        maxlength="64"
        :aria-invalid="invalid === 'builtin-name'"
        aria-describedby="builtin-validation"
      />
      <label class="check"><CheckboxField v-model="draft.enabled" />启用内置工具</label>
      <h3>可用模型</h3>
      <p class="hint">仅在 Agent 允许此工具且选择下列模型时生效，由提供商内部执行。</p>
      <div
        id="builtin-models"
        class="checks"
        tabindex="-1"
        :aria-invalid="invalid === 'builtin-models'"
        aria-describedby="builtin-validation"
      >
        <label v-for="model in models.filter((m) => m.tools)" :key="model.id" class="check"
          ><CheckboxField v-model="draft.modelIds" :value="model.id" />{{ model.id }}</label
        >
      </div>
      <p v-if="!models.some((m) => m.tools)" class="hint">请先添加支持工具调用的模型。</p>
      <label for="builtin-options">工具选项（JSON，可选）</label
      ><textarea
        id="builtin-options"
        v-model="options"
        rows="5"
        style="resize: none"
        aria-describedby="builtin-validation"
        :aria-invalid="invalid === 'builtin-options'"
      />
      <p class="hint">
        类型可自由填写，如 web_search、image_generation、file_search。选项按提供商接口填写，例如
        vector_store_ids、搜索范围或图片尺寸；空对象使用默认值。
      </p>
    </fieldset>
    <p id="builtin-validation" class="error" role="alert">{{ validation || error }}</p>
    <button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存内置工具' }}</button>
  </form>
</template>
