<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { CheckboxField, PaginationField } from '@antarestra/webui/components'
import type { CodexAccountView, CodexWebSearch } from '../src/codex-types.js'

const props = defineProps<{ account: CodexAccountView; busy: boolean; error: string }>()
const emit = defineEmits<{ save: [value: CodexWebSearch]; dirty: [value: boolean] }>()
const draft = reactive<CodexWebSearch>({
  ...props.account.webSearch,
  modelIds: [...props.account.webSearch.modelIds],
})
const initial = JSON.stringify(draft)
const query = ref('')
const page = ref(1)
const validation = ref('')
const available = computed(() => props.account.models.filter((model) => model.tools))
const missing = computed(() =>
  draft.modelIds.filter((id) => !available.value.some((model) => model.id === id)),
)
const filtered = computed(() =>
  available.value.filter((model) =>
    `${model.title} ${model.id}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
)
const visible = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
watch(query, () => {
  page.value = 1
})
watch(draft, () => emit('dirty', JSON.stringify(draft) !== initial), { deep: true })
function save(event: Event) {
  if (props.busy) return
  validation.value =
    draft.enabled && (!draft.modelIds.length || missing.value.length)
      ? '启用网页搜索时，请至少选择一个当前可用模型，并移除已不可用的模型。'
      : ''
  if (validation.value) {
    ;(event.target as HTMLFormElement).querySelector<HTMLElement>('#codex-search-models')?.focus()
    return
  }
  emit('save', { ...draft, modelIds: [...draft.modelIds] })
}
</script>

<template>
  <form id="codex-web-search-form" class="codex-search-form" novalidate @submit.prevent="save">
    <p class="hint">{{ account.email || 'ChatGPT 账户' }} · {{ account.id }}</p>
    <label class="codex-search-check">
      <CheckboxField v-model="draft.enabled" :disabled="busy" />启用原生网页搜索
    </label>
    <p class="hint">
      由 OpenAI
      执行搜索，实际可用性取决于模型和账户策略。只有使用此账户所选模型且获得助理工具授权时才可使用搜索。
      新同步的模型不会自动加入；关闭开关保留模型选择。
    </p>
    <p class="hint">保存设置会停止此账户正在进行的模型调用。已断开账户的设置在重新授权后生效。</p>
    <h3>可用模型</h3>
    <label for="codex-search-query">筛选模型</label>
    <div class="actions">
      <input
        id="codex-search-query"
        v-model="query"
        type="search"
        :disabled="busy"
        autocomplete="off"
      />
      <button v-if="query" type="button" :disabled="busy" @click="query = ''">清空筛选</button>
    </div>
    <p class="hint">已选择 {{ draft.modelIds.length }} 个模型</p>
    <div
      id="codex-search-models"
      tabindex="-1"
      role="group"
      aria-label="网页搜索可用模型"
      :aria-invalid="!!validation"
      aria-describedby="codex-search-error"
    >
      <label v-for="model in visible" :key="model.id" class="codex-search-check">
        <CheckboxField v-model="draft.modelIds" :value="model.id" :disabled="busy" />
        <span
          >{{ model.title }}<code>{{ model.id }}</code></span
        >
      </label>
      <p v-if="!available.length" class="hint">暂无支持工具调用的模型，请关闭弹窗后同步模型。</p>
      <p v-else-if="!filtered.length" class="hint">没有匹配的模型，请修改或清空筛选。</p>
      <label v-for="id in missing" :key="id" class="codex-search-check">
        <CheckboxField v-model="draft.modelIds" :value="id" :disabled="busy" />
        <span>{{ id }}（已不可用，请取消选择）</span>
      </label>
    </div>
    <PaginationField
      v-if="filtered.length > 20"
      v-model:page="page"
      :total="filtered.length"
      :page-size="20"
      :disabled="busy"
      label="网页搜索模型分页"
    />
    <p class="hint">
      保存后，在助理的工具列表中选择此账户下的 web_search；允许全部工具的助理自动包含它。
    </p>
    <p id="codex-search-error" class="codex-feedback" role="alert">{{ validation || error }}</p>
    <p class="hint" role="status">{{ busy ? '正在保存设置…' : '' }}</p>
  </form>
</template>
