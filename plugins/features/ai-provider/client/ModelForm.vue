<script setup lang="ts">
import { CheckboxField, NumberField } from '@antarestra/webui/components'
import { reactive, ref, watch } from 'vue'
import type { ModelDefinition } from '@antarestra/ai'
import { defaultModelLimits, thinkingLevels } from '../src/types.js'
const props = defineProps<{ value?: ModelDefinition; busy: boolean; error: string }>()
const emit = defineEmits<{ save: [value: ModelDefinition]; dirty: [value: boolean] }>()
const draft = reactive<ModelDefinition>(
  props.value
    ? (JSON.parse(JSON.stringify(props.value)) as ModelDefinition)
    : {
        id: '',
        title: '',
        ...defaultModelLimits,
        input: ['text'],
        output: ['text'],
        tools: true,
        thinkingLevels: [],
      },
)
const initial = JSON.stringify(draft)
watch(draft, () => emit('dirty', JSON.stringify(draft) !== initial))
const invalid = ref('')
function save(event: Event) {
  invalid.value = !draft.id.trim()
    ? 'model-id'
    : !draft.title.trim()
      ? 'model-name'
      : !Number.isSafeInteger(draft.contextWindow) || draft.contextWindow < 1
        ? 'model-context'
        : !Number.isSafeInteger(draft.maxOutputTokens) ||
            draft.maxOutputTokens < 1 ||
            draft.maxOutputTokens > draft.contextWindow
          ? 'model-output'
          : ''
  if (invalid.value) {
    ;(event.target as HTMLFormElement).querySelector<HTMLInputElement>(`#${invalid.value}`)?.focus()
    return
  }
  emit('save', JSON.parse(JSON.stringify(draft)) as ModelDefinition)
}
</script>
<template>
  <form class="provider-form" novalidate autocomplete="off" @submit.prevent="save">
    <fieldset :disabled="busy">
      <label for="model-id">模型 ID</label
      ><input
        id="model-id"
        v-model="draft.id"
        :disabled="!!value"
        :aria-invalid="invalid === 'model-id'"
        aria-describedby="model-validation"
        maxlength="200"
      />
      <label for="model-name">显示名称</label
      ><input
        id="model-name"
        v-model="draft.title"
        :aria-invalid="invalid === 'model-name'"
        aria-describedby="model-validation"
        maxlength="200"
      />
      <div class="form-grid">
        <div>
          <label for="model-context">上下文（Token）</label
          ><NumberField
            id="model-context"
            v-model="draft.contextWindow"
            :min="1"
            :aria-invalid="invalid === 'model-context'"
            aria-describedby="model-validation"
          />
        </div>
        <div>
          <label for="model-output">最大输出（Token）</label
          ><NumberField
            id="model-output"
            v-model="draft.maxOutputTokens"
            :min="1"
            :max="draft.contextWindow"
            :aria-invalid="invalid === 'model-output'"
            aria-describedby="model-validation"
          />
        </div>
      </div>
      <fieldset class="checks">
        <legend>模型功能</legend>
        <label><CheckboxField checked disabled />文本输入 / 输出</label
        ><label><CheckboxField v-model="draft.input" value="image" />图片输入</label
        ><label><CheckboxField v-model="draft.tools" />工具调用</label>
      </fieldset>
      <fieldset class="checks">
        <legend>支持的思考强度</legend>
        <label v-for="level in thinkingLevels" :key="level"
          ><CheckboxField v-model="draft.thinkingLevels" :value="level" />{{ level }}</label
        >
      </fieldset>
      <p class="hint">
        不勾选表示不支持思考。请根据模型能力设置，上下文和功能不会由通用模型列表准确返回。
      </p>
    </fieldset>
    <p id="model-validation" role="alert" class="error">
      {{ invalid ? '请填写 ID、名称及有效的 Token 数量；最大输出不能超过上下文。' : error }}
    </p>
    <button class="primary" type="submit" :disabled="busy" :aria-busy="busy">保存模型</button>
  </form>
</template>
