<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { SelectField } from '@antarestra/webui/components'
import { EyeIcon, EyeSlashIcon } from '@antarestra/webui/icons'
import type { ProviderView } from '../src/types.js'
const props = defineProps<{
  value?: ProviderView
  catalog: { id: string; name: string; api: string; baseUrl: string }[]
  formats: { id: string; name: string }[]
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ save: [value: Record<string, unknown>]; dirty: [value: boolean] }>()
const draft = reactive({
  id: props.value?.id ?? '',
  name: props.value?.name ?? '',
  note: props.value?.note ?? '',
  builtin: props.value?.builtin ?? '',
  api: props.value?.api ?? 'openai-completions',
  baseUrl: props.value?.baseUrl ?? '',
  apiKey: '',
  headers: JSON.stringify(props.value?.headers ?? {}, null, 2),
})
const initial = JSON.stringify(draft)
watch(draft, () => emit('dirty', JSON.stringify(draft) !== initial))
const visible = ref(false)
const invalid = ref('')
const template = computed({
  get: () => draft.builtin || '$custom',
  set: (value) => {
    draft.builtin = value === '$custom' ? '' : value
  },
})
const options = computed(() => [{ id: '$custom', name: '自定义提供商' }, ...props.catalog])
function preset(id: string) {
  const item = props.catalog.find((item) => item.id === id)
  if (!item) return
  if (!props.value) {
    draft.id = item.id
    draft.name = item.name
  }
  draft.api = item.api
  draft.baseUrl = item.baseUrl
}
function save(event: Event) {
  invalid.value = ''
  for (const key of ['id', 'name', 'baseUrl'] as const) {
    if (!draft[key].trim()) {
      invalid.value = key
      ;(event.target as HTMLFormElement).querySelector<HTMLInputElement>(`[name="${key}"]`)?.focus()
      return
    }
  }
  let headers: unknown
  try {
    headers = JSON.parse(draft.headers)
    if (
      !headers ||
      Array.isArray(headers) ||
      typeof headers !== 'object' ||
      Object.values(headers).some((value) => typeof value !== 'string')
    )
      throw new Error()
  } catch {
    invalid.value = 'headers'
    ;(event.target as HTMLFormElement)
      .querySelector<HTMLTextAreaElement>('textarea[name="headers"]')
      ?.focus()
    return
  }
  emit('save', { ...draft, headers, ...(props.value ? { revision: props.value.revision } : {}) })
}
</script>
<template>
  <form class="provider-form" novalidate autocomplete="off" @submit.prevent="save">
    <fieldset :disabled="busy">
      <label for="provider-builtin">提供商模板</label>
      <SelectField
        id="provider-builtin"
        v-model="template"
        label="提供商模板"
        :options="options"
        searchable
        @update:model-value="preset"
      />
      <p class="hint">模板填入默认接口和地址，也可按实际接入方式修改。</p>
      <div class="form-grid">
        <div>
          <label for="provider-id">提供商 ID</label
          ><input
            id="provider-id"
            v-model="draft.id"
            name="id"
            :disabled="!!value"
            maxlength="200"
            :aria-invalid="invalid === 'id'"
            aria-describedby="provider-validation"
          />
        </div>
        <div>
          <label for="provider-name">名称</label
          ><input
            id="provider-name"
            v-model="draft.name"
            name="name"
            maxlength="200"
            :aria-invalid="invalid === 'name'"
            aria-describedby="provider-validation"
          />
        </div>
      </div>
      <label for="provider-note">备注</label
      ><textarea
        id="provider-note"
        v-model="draft.note"
        rows="3"
        maxlength="2000"
        style="resize: none"
      />
      <label for="provider-api">接口格式</label
      ><SelectField id="provider-api" v-model="draft.api" label="接口格式" :options="formats" />
      <label for="provider-url">Base URL</label
      ><input
        id="provider-url"
        v-model="draft.baseUrl"
        name="baseUrl"
        type="url"
        placeholder="https://api.example.com/v1"
        :aria-invalid="invalid === 'baseUrl'"
        aria-describedby="provider-validation"
      />
      <label for="provider-key">API Key</label>
      <div class="secret-field">
        <input
          id="provider-key"
          v-model="draft.apiKey"
          :type="visible ? 'text' : 'password'"
          autocomplete="new-password"
          :placeholder="value?.apiKeyPlaceholder || '输入 API Key（无密钥服务可留空）'"
          aria-describedby="provider-key-help"
        /><button
          type="button"
          :aria-label="visible ? '隐藏新 API Key' : '显示新 API Key'"
          :aria-pressed="visible"
          @click="visible = !visible"
        >
          <component :is="visible ? EyeSlashIcon : EyeIcon" class="ui-icon" aria-hidden="true" />
        </button>
      </div>
      <p id="provider-key-help" class="hint">
        {{
          value?.apiKeyPlaceholder
            ? '已保存密钥仅作占位提示。留空保留，输入新密钥后替换。'
            : '密钥保存在服务端，保存后不回传原值。'
        }}
      </p>
      <label for="provider-headers">额外 Header（JSON）</label
      ><textarea
        id="provider-headers"
        style="resize: none"
        v-model="draft.headers"
        name="headers"
        rows="5"
        spellcheck="false"
        :aria-invalid="invalid === 'headers'"
        aria-describedby="provider-validation"
      />
    </fieldset>
    <p id="provider-validation" class="error" role="alert">
      {{
        invalid === 'headers'
          ? '请输入 JSON 对象，Header 的名称和值均为字符串。'
          : invalid
            ? '请填写提供商 ID、名称和 Base URL。'
            : error
      }}
    </p>
    <button class="primary" type="submit" :disabled="busy" :aria-busy="busy">保存提供商</button>
  </form>
</template>
