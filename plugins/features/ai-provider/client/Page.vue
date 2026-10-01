<script setup lang="ts">
import { PaginationField, CheckboxField, EditorDialog } from '@antarestra/webui/components'
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import { PlusIcon, ArrowPathIcon, ArrowLeftIcon } from '@antarestra/webui/icons'
import type { ModelDefinition } from '@antarestra/ai'
import type { ProviderView, Candidate, Discovery, BuiltinTool } from '../src/types.js'
import BuiltinToolForm from './BuiltinToolForm.vue'
import ProviderForm from './ProviderForm.vue'
import ModelForm from './ModelForm.vue'
import { syncModels } from './models.js'
import './style.css'

const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const providers = ref<ProviderView[]>([])
const loaded = ref(false)
const selected = ref(String(router.currentRoute.value.query.provider ?? ''))
const current = computed(() => providers.value.find((item) => item.id === selected.value))
const catalog = ref<{ id: string; name: string; api: string; baseUrl: string }[]>([])
const formats = ref<{ id: string; name: string }[]>([])
const search = ref('')
const searchInput = ref<HTMLInputElement>()
const page = ref(1)
const modelPage = ref(1)
const candidatePage = ref(1)
const candidateSearch = ref('')
const candidateInput = ref<HTMLInputElement>()
function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}
function clearCandidateSearch() {
  candidateSearch.value = ''
  candidateInput.value?.focus()
}
function closeSync() {
  syncDialog.value = false
  message.value = ''
}
const providerDialog = ref(false)
const editingProvider = ref<ProviderView>()
const modelDialog = ref(false)
const editingModel = ref<ModelDefinition>()
const dirty = ref(false)
const toolDialog = ref(false)
const editingTool = ref<BuiltinTool>()
function editTool(value?: BuiltinTool) {
  editingTool.value = value
  dirty.value = false
  message.value = ''
  toolDialog.value = true
}
function saveTool(tool: BuiltinTool) {
  void run(async () => {
    const provider = current.value!
    const tools = (provider.builtinTools ?? []).filter((t) => t.name !== editingTool.value?.name)
    tools.push(tool)
    const result = await api<ProviderView>(
      path() + '/builtin-tools',
      { revision: provider.revision, tools },
      'PUT',
    )
    if (!alive) return
    update(result)
    dirty.value = toolDialog.value = false
    feedback.toast('内置工具已保存')
  })
}
function removeTool(tool: BuiltinTool) {
  void run(async () => {
    if (
      !(await feedback.modal(
        `删除内置工具 ${tool.name}？`,
        '删除后此提供商不再提供该工具，正在使用此提供商的运行会中断。',
      ))
    )
      return
    const provider = current.value!
    const result = await api<ProviderView>(
      path() + '/builtin-tools',
      {
        revision: provider.revision,
        tools: (provider.builtinTools ?? []).filter((t) => t.name !== tool.name),
      },
      'PUT',
    )
    if (alive) {
      update(result)
      feedback.toast('内置工具已删除')
    }
  })
}
const syncDialog = ref(false)
const candidates = ref<Candidate[]>([])
const warning = ref('')
const selection = ref<string[]>([])
const size = 20
let alive = true
const providerRows = computed(() =>
  providers.value.filter((item) =>
    `${item.id} ${item.name} ${item.note}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
const visibleProviders = computed(() =>
  providerRows.value.slice((page.value - 1) * size, page.value * size),
)
const models = computed(() => current.value?.models ?? [])
const visibleModels = computed(() =>
  models.value.slice((modelPage.value - 1) * size, modelPage.value * size),
)
const filteredCandidates = computed(() =>
  candidates.value.filter((item) =>
    `${item.id} ${item.title}`.toLowerCase().includes(candidateSearch.value.toLowerCase()),
  ),
)
const visibleCandidates = computed(() =>
  filteredCandidates.value.slice((candidatePage.value - 1) * size, candidatePage.value * size),
)
watch(search, () => {
  page.value = 1
})
watch(candidateSearch, () => {
  candidatePage.value = 1
})
watch(
  () => router.currentRoute.value.query.provider,
  (value) => {
    selected.value = typeof value === 'string' ? value : ''
    modelPage.value = 1
  },
)
function path() {
  return '/ai-providers/' + encodeURIComponent(selected.value)
}
async function load() {
  const [items, builtins] = await Promise.all([
    api<ProviderView[]>('/ai-providers'),
    api<{ providers: typeof catalog.value; formats: typeof formats.value }>(
      '/ai-providers/catalog',
    ),
  ])
  if (!alive) return
  providers.value = items
  catalog.value = builtins.providers
  formats.value = builtins.formats
  loaded.value = true
  page.value = Math.min(page.value, Math.max(1, Math.ceil(providerRows.value.length / size)))
}
function select(id: string) {
  selected.value = id
  modelPage.value = 1
  message.value = ''
  void router.replace({ query: { ...router.currentRoute.value.query, provider: id || undefined } })
}
function update(provider: ProviderView) {
  const index = providers.value.findIndex((item) => item.id === provider.id)
  if (index < 0) providers.value.push(provider)
  else providers.value[index] = provider
  modelPage.value = Math.min(modelPage.value, Math.max(1, Math.ceil(provider.models.length / size)))
}
function editProvider(value?: ProviderView) {
  editingProvider.value = value
  dirty.value = false
  message.value = ''
  providerDialog.value = true
}
function editModel(value?: ModelDefinition) {
  editingModel.value = value
  dirty.value = false
  message.value = ''
  modelDialog.value = true
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的修改？', '关闭后当前输入将丢失，已保存的配置不受影响。'))
  )
}
async function closeEditor() {
  if (busy.value || !(await discard())) return
  providerDialog.value = modelDialog.value = toolDialog.value = dirty.value = false
  message.value = ''
}
function saveProvider(body: Record<string, unknown>) {
  void run(async () => {
    const value = await api<ProviderView>(
      '/ai-providers' +
        (editingProvider.value ? '/' + encodeURIComponent(editingProvider.value.id) : ''),
      body,
      editingProvider.value ? 'PUT' : 'POST',
    )
    if (!alive) return
    update(value)
    dirty.value = providerDialog.value = false
    select(value.id)
    feedback.toast('提供商已保存')
  })
}
async function saveModels(values: ModelDefinition[]) {
  const provider = current.value!
  const result = await api<ProviderView>(
    path() + '/models',
    { revision: provider.revision, models: values },
    'PUT',
  )
  if (alive) update(result)
}
function saveModel(value: ModelDefinition) {
  void run(async () => {
    if (!editingModel.value && models.value.some((model) => model.id === value.id))
      throw new Error('模型 ID 已存在，请编辑已有模型')
    await saveModels(
      editingModel.value
        ? models.value.map((model) => (model.id === value.id ? value : model))
        : [...models.value, value],
    )
    if (!alive) return
    dirty.value = modelDialog.value = false
    feedback.toast('模型已保存')
  })
}
function removeProvider() {
  void run(async () => {
    const provider = current.value!
    if (
      !(await feedback.modal(
        `删除提供商“${provider.name}”？`,
        '将删除其配置和模型，并中断使用此提供商的运行。此操作不可撤销。',
      ))
    )
      return
    await api(path(), { revision: provider.revision }, 'DELETE')
    if (!alive) return
    providers.value = providers.value.filter((item) => item.id !== provider.id)
    select('')
    feedback.toast('提供商已删除')
  })
}
function removeModel(model: ModelDefinition) {
  void run(async () => {
    if (
      !(await feedback.modal(
        `删除模型“${model.title}”？`,
        '引用此模型的预设将无法使用它，当前提供商的运行会中断。',
      ))
    )
      return
    await saveModels(models.value.filter((item) => item.id !== model.id))
    if (alive) feedback.toast('模型已删除')
  })
}
function openSync() {
  syncDialog.value = true
  candidates.value = []
  selection.value = []
  warning.value = ''
  candidateSearch.value = ''
  candidatePage.value = 1
  void run(async () => {
    const result = await api<Discovery>(path() + '/candidates')
    if (alive) candidates.value = result.models
  })
}
function fetchModels() {
  void run(async () => {
    const result = await api<Discovery>(path() + '/discover', {})
    if (!alive) return
    candidates.value = result.models
    warning.value = result.warning
    selection.value = selection.value.filter((id) =>
      candidates.value.some((model) => model.id === id),
    )
    candidatePage.value = 1
    if (!warning.value) feedback.toast('模型列表已获取')
  })
}
function sync(all: boolean) {
  void run(async () => {
    const selected = candidates.value.filter((item) => all || selection.value.includes(item.id))
    if (!selected.length) return
    await saveModels(syncModels(models.value, selected))
    if (!alive) return
    selection.value = []
    feedback.toast(`已同步 ${selected.length} 个模型`)
  })
}
function checkPage(checked: boolean) {
  const ids = visibleCandidates.value.map((item) => item.id)
  selection.value = checked
    ? [...new Set([...selection.value, ...ids])]
    : selection.value.filter((id) => !ids.includes(id))
}
const stopGuard = router.beforeEach(async () => await discard())
const unload = (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => {
  window.addEventListener('beforeunload', unload)
  void run(load)
})
onUnmounted(() => {
  alive = false
  stopGuard()
  window.removeEventListener('beforeunload', unload)
})
</script>

<template>
  <section class="ai-providers" :aria-busy="busy">
    <header class="page-heading">
      <div>
        <p class="muted">连接模型服务，管理可供 AI 使用的模型。</p>
      </div>
      <div class="actions">
        <button :disabled="busy" aria-label="刷新提供商" title="刷新" @click="run(load)">
          <ArrowPathIcon class="ui-icon" /></button
        ><button class="primary" :disabled="busy || !loaded" @click="editProvider()">
          <PlusIcon class="ui-icon" />新增提供商
        </button>
      </div>
    </header>
    <p
      v-if="message && !providerDialog && !modelDialog && !toolDialog && !syncDialog"
      class="error"
      role="alert"
    >
      {{ message }}
    </p>
    <p v-if="!loaded" class="state" role="status">
      {{ busy ? '正在加载提供商…' : '加载失败，请点击刷新重试。' }}
    </p>
    <template v-else-if="!current">
      <div class="search-row">
        <label for="provider-search">筛选提供商</label
        ><input
          id="provider-search"
          ref="searchInput"
          v-model="search"
          type="search"
          placeholder="名称、ID 或备注"
        /><button v-if="search" @click="clearSearch">清空</button
        ><span class="muted">共 {{ providerRows.length }} 个</span>
      </div>
      <div class="provider-cards">
        <button
          v-for="provider in visibleProviders"
          :key="provider.id"
          class="provider-card"
          :disabled="busy"
          @click="select(provider.id)"
        >
          <span class="card-title">{{ provider.name }}</span
          ><code>{{ provider.id }}</code
          ><span class="muted">{{ provider.note || '暂无备注' }}</span
          ><span class="card-meta"
            ><span>{{ provider.api }}</span
            ><strong>{{ provider.models.length }} 个模型</strong></span
          >
        </button>
      </div>
      <p v-if="!providerRows.length" class="state">
        {{
          providers.length
            ? '没有匹配的提供商，请调整筛选条件。'
            : '尚未接入提供商，点击“新增提供商”开始配置。'
        }}
      </p>
      <PaginationField
        v-if="providerRows.length > size"
        v-model:page="page"
        :total="providerRows.length"
        :page-size="size"
        :disabled="busy"
        class="pagination"
        label="提供商分页"
      />
    </template>
    <template v-else>
      <button class="back" :disabled="busy" @click="select('')">
        <ArrowLeftIcon class="ui-icon" />全部提供商
      </button>
      <div class="provider-detail">
        <div>
          <h2>{{ current.name }}</h2>
          <code>{{ current.id }}</code>
          <p class="muted">{{ current.note || '暂无备注' }}</p>
          <p class="endpoint">{{ current.api }} · {{ current.baseUrl }}</p>
        </div>
        <div class="actions">
          <button :disabled="busy" @click="editProvider(current)">编辑提供商</button
          ><button class="danger" :disabled="busy" @click="removeProvider">删除提供商</button>
        </div>
      </div>
      <div class="model-heading">
        <h2>
          提供商内置工具 <span class="count">{{ current.builtinTools?.length ?? 0 }}</span>
        </h2>
        <button
          class="primary"
          :disabled="
            busy ||
            !['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(
              current.api,
            )
          "
          @click="editTool()"
        >
          添加内置工具
        </button>
      </div>
      <p class="hint">
        内置工具由提供商内部调用，可在 Agents 中选择。需要 OpenAI Responses
        接口；修改后正在使用此提供商的运行会中断。
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>工具名 / 类型</th>
              <th>可用模型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tool in current.builtinTools ?? []" :key="tool.name">
              <td>
                <strong>{{ tool.name }}</strong
                ><code>{{ tool.type }}</code>
              </td>
              <td>{{ tool.modelIds.join('、') }}</td>
              <td>{{ tool.enabled ? '已启用' : '已停用' }}</td>
              <td>
                <div class="actions">
                  <button :disabled="busy" @click="editTool(tool)">编辑</button
                  ><button class="danger" :disabled="busy" @click="removeTool(tool)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!current.builtinTools?.length" class="state">
          尚无内置工具，添加后可为已有模型启用搜索或图片生成。
        </p>
      </div>
      <div class="model-heading">
        <h2>
          模型 <span class="count">{{ models.length }}</span>
        </h2>
        <div class="actions">
          <button :disabled="busy" @click="openSync">同步模型</button
          ><button class="primary" :disabled="busy" @click="editModel()">添加模型</button>
        </div>
      </div>
      <p class="hint">修改提供商或模型配置后立即生效，正在使用此提供商的运行会中断。</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>模型 / ID</th>
              <th>上下文 / 最大输出</th>
              <th>模型功能</th>
              <th>思考强度</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in visibleModels" :key="model.id">
              <td>
                <strong>{{ model.title }}</strong
                ><code>{{ model.id }}</code>
              </td>
              <td>
                {{ model.contextWindow.toLocaleString('zh-CN')
                }}<small>{{ model.maxOutputTokens.toLocaleString('zh-CN') }}</small>
              </td>
              <td>
                文本{{ model.input.includes('image') ? ' · 图片' : ''
                }}{{ model.tools ? ' · 工具' : '' }}
              </td>
              <td>{{ model.thinkingLevels.join(' / ') || '不支持' }}</td>
              <td>
                <div class="actions">
                  <button :disabled="busy" @click="editModel(model)">编辑</button
                  ><button class="danger" :disabled="busy" @click="removeModel(model)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!models.length" class="state">暂无模型，可同步模型目录或手动添加。</p>
      </div>
      <PaginationField
        v-if="models.length > size"
        v-model:page="modelPage"
        :total="models.length"
        :page-size="size"
        :disabled="busy"
        class="pagination"
        label="模型分页"
      />
    </template>
    <EditorDialog
      v-if="providerDialog"
      :title="editingProvider ? '编辑提供商' : '新增提供商'"
      :busy="busy"
      @close="closeEditor"
      ><ProviderForm
        v-bind="editingProvider ? { value: editingProvider } : {}"
        :catalog="catalog"
        :formats="formats"
        :busy="busy"
        :error="message"
        @dirty="dirty = $event"
        @save="saveProvider"
    /></EditorDialog>
    <EditorDialog
      v-if="modelDialog"
      :title="editingModel ? '编辑模型' : '添加模型'"
      :busy="busy"
      @close="closeEditor"
      ><ModelForm
        v-bind="editingModel ? { value: editingModel } : {}"
        :busy="busy"
        :error="message"
        @dirty="dirty = $event"
        @save="saveModel"
    /></EditorDialog>
    <EditorDialog v-if="syncDialog" title="同步模型" :busy="busy" @close="closeSync">
      <div class="sync-panel">
        <p class="hint">
          内置目录与远端结果按模型 ID 合并。同步会新增模型并覆盖同 ID
          模型的已有设置，未选中的模型保留。全部同步包含筛选外的模型。缺少参数时默认使用 128000
          上下文、65535 最大输出，请同步后核对。
        </p>
        <div class="actions">
          <button :disabled="busy" @click="fetchModels">获取模型列表</button
          ><span role="status" class="muted">{{
            busy ? '正在处理…' : `${candidates.length} 个候选模型`
          }}</span>
        </div>
        <p v-if="warning" class="warning" role="status">{{ warning }}</p>
        <p v-if="message" class="error" role="alert">{{ message }}</p>
        <div class="search-row">
          <label for="candidate-search">筛选模型</label
          ><input
            id="candidate-search"
            ref="candidateInput"
            v-model="candidateSearch"
            type="search"
            placeholder="模型 ID 或名称"
          /><button v-if="candidateSearch" @click="clearCandidateSearch">清空</button>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>
                  <CheckboxField
                    aria-label="选择本页模型"
                    :disabled="busy || !visibleCandidates.length"
                    :checked="
                      visibleCandidates.length > 0 &&
                      visibleCandidates.every((item) => selection.includes(item.id))
                    "
                    :indeterminate="
                      visibleCandidates.some((item) => selection.includes(item.id)) &&
                      !visibleCandidates.every((item) => selection.includes(item.id))
                    "
                    @change="checkPage"
                  />
                </th>
                <th>模型</th>
                <th>来源</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="model in visibleCandidates" :key="model.id">
                <td>
                  <CheckboxField
                    v-model="selection"
                    :value="model.id"
                    :aria-label="`选择 ${model.title}`"
                    :disabled="busy"
                  />
                </td>
                <td>
                  <strong>{{ model.title }}</strong
                  ><code>{{ model.id }}</code>
                </td>
                <td>
                  {{
                    model.source === 'both'
                      ? '内置 + API'
                      : model.source === 'builtin'
                        ? '内置'
                        : 'API'
                  }}
                </td>
                <td>
                  {{ models.some((item) => item.id === model.id) ? '已存在，将覆盖' : '待新增' }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!filteredCandidates.length" class="state">
            {{
              busy
                ? '正在加载模型…'
                : candidates.length
                  ? '没有匹配的模型。'
                  : '暂无候选模型，点击“获取模型列表”或返回手动添加。'
            }}
          </p>
        </div>
        <PaginationField
          v-model:page="candidatePage"
          :total="filteredCandidates.length"
          :page-size="size"
          :disabled="busy"
          class="pagination"
          label="候选模型分页"
        />
      </div>
      <template #footer>
        <button :disabled="busy || !candidates.length" @click="sync(true)">
          同步并覆盖全部（{{ candidates.length }}）</button
        ><button class="primary" :disabled="busy || !selection.length" @click="sync(false)">
          同步并覆盖所选（{{ selection.length }}）
        </button>
      </template>
    </EditorDialog>
    <EditorDialog
      v-if="toolDialog"
      :title="editingTool ? '编辑内置工具' : '添加内置工具'"
      :busy="busy"
      @close="closeEditor"
    >
      <BuiltinToolForm
        v-bind="editingTool ? { value: editingTool } : {}"
        :models="models"
        :busy="busy"
        :error="message"
        @dirty="dirty = $event"
        @save="saveTool"
      />
    </EditorDialog>
  </section>
</template>
