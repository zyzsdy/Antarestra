<script setup lang="ts">
import { CheckboxField } from '@antarestra/webui/components'
import { computed, reactive, ref, watch } from 'vue'
import {
  SelectField,
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@antarestra/webui/components'
import type { ModelRef, JsonObject } from '@antarestra/ai'
import { newAgent, defaultAgentId } from '../src/types.js'
import type { AgentRecord, Capabilities } from '../src/types.js'
const props = defineProps<{
  value: AgentRecord | undefined
  capabilities: Capabilities
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ save: [value: AgentRecord]; dirty: [value: boolean] }>()
const draft = reactive<AgentRecord>(
  props.value ? (JSON.parse(JSON.stringify(props.value)) as AgentRecord) : newAgent(),
)
const extensionText = ref(JSON.stringify(draft.extensions, null, 2))
const skillText = ref(draft.skillIds?.join('\n') ?? '')
const initial = JSON.stringify({ draft, extensions: extensionText.value, skills: skillText.value })
watch(
  [draft, extensionText, skillText],
  () =>
    emit(
      'dirty',
      JSON.stringify({ draft, extensions: extensionText.value, skills: skillText.value }) !==
        initial,
    ),
  { deep: true },
)
const invalid = ref('')
const validation = ref('')
const modelKey = (m: ModelRef) => JSON.stringify([m.providerId, m.modelId])
const modelOptions = computed(() => {
  const options = props.capabilities.providers.flatMap((p) =>
    p.models.map((m) => ({
      id: modelKey({ providerId: p.id, modelId: m.id }),
      name: `${p.title} / ${m.title}`,
      description: `${p.id} / ${m.id}`,
    })),
  )
  for (const m of [...(draft.models ?? []), ...(draft.defaultModel ? [draft.defaultModel] : [])]) {
    if (!options.some((o) => o.id === modelKey(m)))
      options.push({
        id: modelKey(m),
        name: `${m.providerId} / ${m.modelId}（当前未注册）`,
        description: '',
      })
  }
  return options
})
const selectedModels = computed({
  get: () => draft.models?.map(modelKey) ?? [],
  set: (ids: string[]) => {
    draft.models = ids.map((id) => {
      const [providerId, modelId] = JSON.parse(id) as [string, string]
      return { providerId, modelId }
    })
  },
})
const defaultModel = computed({
  get: () => (draft.defaultModel ? modelKey(draft.defaultModel) : 'auto'),
  set: (id: string) => {
    if (id === 'auto') draft.defaultModel = null
    else {
      const [providerId, modelId] = JSON.parse(id) as [string, string]
      draft.defaultModel = { providerId, modelId }
    }
  },
})
const defaultOptions = computed(() => [
  { id: 'auto', name: '自动选择允许列表中的第一个模型' },
  ...modelOptions.value.filter((m) => draft.models === null || selectedModels.value.includes(m.id)),
])
const toolOptions = computed(() => [
  ...new Set([...props.capabilities.tools.map((t) => t.id), ...(draft.toolIds ?? [])]),
])
const backends = computed(() =>
  [...new Set([...props.capabilities.backends, draft.backendId])].map((id) => ({ id, name: id })),
)
function save(event: Event) {
  invalid.value = ''
  validation.value = ''
  if (!draft.id.trim()) {
    invalid.value = 'agent-id'
    validation.value = '请填写 Agent ID。'
  } else if (!draft.title.trim()) {
    invalid.value = 'agent-title'
    validation.value = '请填写名称。'
  } else if (
    draft.defaultModel &&
    draft.models !== null &&
    !selectedModels.value.includes(modelKey(draft.defaultModel))
  ) {
    invalid.value = 'agent-default-model'
    validation.value = '请选择允许列表内的默认模型，或改为自动选择。'
  }
  let extensions: Record<string, JsonObject> = {}
  try {
    const value: unknown = JSON.parse(extensionText.value)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((v) => !v || typeof v !== 'object' || Array.isArray(v))
    )
      throw new Error()
    extensions = value as Record<string, JsonObject>
  } catch {
    invalid.value = 'agent-extensions'
    validation.value = '扩展配置需为 JSON 对象，每个扩展的值也需为对象。'
  }
  if (invalid.value) {
    ;(event.target as HTMLFormElement).querySelector<HTMLElement>(`#${invalid.value}`)?.focus()
    return
  }
  const value = JSON.parse(JSON.stringify(draft)) as AgentRecord
  value.extensions = extensions
  if (value.skillIds !== null)
    value.skillIds = [
      ...new Set(
        skillText.value
          .split(/[\n,，]/)
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ]
  if (!value.defaultThinking) delete value.defaultThinking
  emit('save', value)
}
</script>
<template>
  <form
    id="agent-editor-form"
    class="agents-form"
    novalidate
    autocomplete="off"
    @submit.prevent="save"
  >
    <p v-if="value?.id === defaultAgentId" class="agents-hint">
      所有用户未选定 Agent 时使用此助理。除固定标识和删除保护外，配置均可修改。
    </p>
    <fieldset :disabled="busy">
      <div class="agents-grid">
        <div>
          <label for="agent-title">名称</label
          ><input
            id="agent-title"
            v-model="draft.title"
            maxlength="200"
            :aria-invalid="invalid === 'agent-title'"
            aria-describedby="agent-validation"
          />
        </div>
        <div>
          <label for="agent-id">Agent ID</label
          ><input
            id="agent-id"
            v-model="draft.id"
            :disabled="!!value"
            maxlength="200"
            :aria-invalid="invalid === 'agent-id'"
            aria-describedby="agent-validation"
          />
        </div>
      </div>
      <label for="agent-system">系统提示词模板</label>
      <textarea
        style="resize: none"
        id="agent-system"
        v-model="draft.systemTemplate"
        rows="14"
        maxlength="65536"
      />
      <p class="agents-hint">
        定义助理的职责、语气和行动规则。模板支持双花括号变量，如 <code v-pre>{{ input }}</code
        >；自定义变量须由调用方提供。
      </p>
      <section class="agents-scope">
        <h3>可用模型</h3>
        <label class="agents-check"
          ><CheckboxField
            :checked="draft.models === null"
            @change="draft.models = $event ? null : []"
          />允许全部模型，包括以后新增的模型</label
        >
        <div v-if="draft.models !== null" class="agents-options">
          <label v-for="model in modelOptions" :key="model.id" class="agents-check"
            ><CheckboxField v-model="selectedModels" :value="model.id" /><span
              >{{ model.name }}<small>{{ model.description }}</small></span
            ></label
          >
          <p v-if="!modelOptions.length" class="agents-hint">
            尚无模型，请先在“提供商接入”中添加。空列表不允许运行。
          </p>
        </div>
        <label for="agent-default-model">默认模型</label
        ><SelectField
          id="agent-default-model"
          v-model="defaultModel"
          label="默认模型"
          :options="defaultOptions"
          searchable
          :disabled="busy"
        />
      </section>
      <section class="agents-scope">
        <h3>可用工具</h3>
        <label class="agents-check"
          ><CheckboxField
            :checked="draft.toolIds === null"
            @change="draft.toolIds = $event ? null : []"
          />允许全部工具，包括以后新增的工具</label
        >
        <div v-if="draft.toolIds !== null" class="agents-options">
          <label v-for="id in toolOptions" :key="id" class="agents-check"
            ><CheckboxField v-model="draft.toolIds" :value="id" /><span
              >{{ id
              }}<small>{{
                capabilities.tools.find((t) => t.id === id)?.description ?? '当前未注册'
              }}</small></span
            ></label
          >
          <p v-if="!toolOptions.length" class="agents-hint">
            尚无已注册工具。空列表表示禁用普通工具。
          </p>
        </div>
      </section>
      <section class="agents-scope">
        <h3>可用 Skill</h3>
        <label class="agents-check"
          ><CheckboxField
            :checked="draft.skillIds === null"
            @change="draft.skillIds = $event ? null : []"
          />允许全部 Skill，包括以后新增的 Skill</label
        >
        <template v-if="draft.skillIds !== null"
          ><label for="agent-skills">允许的 Skill ID（每行一个）</label
          ><textarea style="resize: none" id="agent-skills" v-model="skillText" rows="4" />
          <p class="agents-hint">
            留空表示禁用 Skill；具体 ID 与访问范围由 Skill 服务校验。
          </p></template
        >
        <p v-if="!capabilities.skillsAvailable" class="agents-hint">
          当前未接入 Skill 服务。“全部”范围会在服务接入后自动生效。
        </p>
      </section>
      <CollapsibleRoot class="agents-advanced">
        <CollapsibleTrigger class="agents-advanced-trigger">高级配置</CollapsibleTrigger>
        <CollapsibleContent>
          <label for="agent-backend">执行后端</label
          ><SelectField
            id="agent-backend"
            v-model="draft.backendId"
            label="执行后端"
            :options="backends"
            editable
            :disabled="busy"
          />
          <label for="agent-thinking">默认思考等级</label
          ><input
            id="agent-thinking"
            v-model="draft.defaultThinking"
            placeholder="留空使用模型默认值"
          />
          <label for="agent-user">用户消息模板</label
          ><textarea
            style="resize: none"
            id="agent-user"
            v-model="draft.userTemplate"
            rows="4"
            maxlength="65536"
          />
          <label for="agent-extensions">扩展配置（JSON）</label
          ><textarea
            style="resize: none"
            id="agent-extensions"
            v-model="extensionText"
            rows="6"
            :aria-invalid="invalid === 'agent-extensions'"
            aria-describedby="agent-validation"
          />
        </CollapsibleContent>
      </CollapsibleRoot>
    </fieldset>
    <p id="agent-validation" class="agents-error" role="alert">{{ validation || error }}</p>
  </form>
</template>
