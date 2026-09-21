<script setup lang="ts">
import { PaginationField, EditorDialog } from '@antarestra/webui/components'
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import { defaultAgentId } from '../src/types.js'
import type { AgentRecord, Capabilities } from '../src/types.js'
import AgentForm from './AgentForm.vue'
import './style.css'
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const agents = ref<AgentRecord[]>([])
const capabilities = ref<Capabilities>({
  providers: [],
  tools: [],
  backends: [],
  skillsAvailable: false,
})
const loaded = ref(false)
const dialog = ref(false)
const editing = ref<AgentRecord>()
const dirty = ref(false)
const search = ref('')
const searchInput = ref<HTMLInputElement>()
function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}
const page = ref(1)
const filtered = computed(() =>
  agents.value.filter((a) =>
    `${a.title} ${a.id}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
watch(search, () => {
  page.value = 1
})
let alive = true
async function load() {
  const [result, available] = await Promise.all([
    api<{ agents: AgentRecord[] }>('/ai-agents'),
    api<Capabilities>('/ai-agents/capabilities'),
  ])
  if (!alive) return
  agents.value = result.agents.sort(
    (a, b) =>
      Number(b.id === defaultAgentId) - Number(a.id === defaultAgentId) ||
      a.title.localeCompare(b.title, 'zh-CN'),
  )
  capabilities.value = available
  loaded.value = true
  page.value = Math.min(page.value, pages.value)
}
function edit(value?: AgentRecord) {
  editing.value = value
  dirty.value = false
  message.value = ''
  dialog.value = true
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的修改？', '当前输入将丢失，已保存的 Agent 配置不受影响。'))
  )
}
async function close() {
  if (busy.value || !(await discard())) return
  dialog.value = dirty.value = false
  message.value = ''
}
function save(value: AgentRecord) {
  void run(async () => {
    const saved = await api<AgentRecord>(
      '/ai-agents' + (editing.value ? '/' + encodeURIComponent(editing.value.id) : ''),
      value,
      editing.value ? 'PUT' : 'POST',
    )
    if (!alive) return
    const index = agents.value.findIndex((a) => a.id === saved.id)
    if (index < 0) agents.value.push(saved)
    else agents.value[index] = saved
    dialog.value = dirty.value = false
    feedback.toast('Agent 已保存')
  })
}
function remove(value: AgentRecord) {
  void run(async () => {
    if (
      !(await feedback.modal(
        `删除 Agent“${value.title}”？`,
        '此操作不能撤销，将取消该 Agent 的运行。已有会话和历史保留，但不能继续使用该 Agent。',
      ))
    )
      return
    await api('/ai-agents/' + encodeURIComponent(value.id), { revision: value.revision }, 'DELETE')
    if (!alive) return
    agents.value = agents.value.filter((a) => a.id !== value.id)
    page.value = Math.min(page.value, pages.value)
    feedback.toast('Agent 已删除')
  })
}
const stopGuard = router.beforeEach(async () => !busy.value && (await discard()))
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
  <div class="agents-page">
    <header class="agents-heading">
      <div>
        <p>配置助理的提示词、模型与能力范围。</p>
      </div>
      <div class="agents-actions">
        <button :disabled="busy" @click="run(load)">刷新</button
        ><button class="agents-primary" :disabled="busy || !loaded" @click="edit()">
          新建 Agent
        </button>
      </div>
    </header>
    <p class="agents-hint agents-banner">
      默认助理用于所有用户未选定 Agent
      的新会话。修改配置在下一次运行生效，正在运行的任务保留原有快照。
    </p>
    <p v-if="message && !dialog" class="agents-error" role="alert">{{ message }}</p>
    <section class="agents-panel" :aria-busy="busy">
      <div class="agents-toolbar">
        <label for="agents-search">筛选 Agent</label
        ><input
          id="agents-search"
          ref="searchInput"
          v-model="search"
          placeholder="名称或 ID"
        /><button v-if="search" @click="clearSearch">清空筛选</button
        ><span role="status">共 {{ filtered.length }} 个</span>
      </div>
      <p v-if="!loaded" role="status">
        {{ busy ? '正在加载 Agents…' : '加载未完成，请刷新重试。' }}
      </p>
      <div v-else class="agents-table">
        <table>
          <thead>
            <tr>
              <th>助理</th>
              <th>模型</th>
              <th>工具</th>
              <th>Skill</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="agent in rows" :key="agent.id">
              <td>
                <strong>{{ agent.title }}</strong
                ><span v-if="agent.id === defaultAgentId" class="agents-badge">默认</span
                ><small>{{ agent.id }}</small>
              </td>
              <td>{{ agent.models === null ? '全部（含新增）' : `${agent.models.length} 个` }}</td>
              <td>
                {{ agent.toolIds === null ? '全部（含新增）' : `${agent.toolIds.length} 个` }}
              </td>
              <td>
                {{ agent.skillIds === null ? '全部（含新增）' : `${agent.skillIds.length} 个` }}
              </td>
              <td>
                <div class="agents-actions">
                  <button :disabled="busy" :aria-label="`编辑 ${agent.title}`" @click="edit(agent)">
                    编辑</button
                  ><button
                    class="agents-danger"
                    :disabled="busy || agent.id === defaultAgentId"
                    :title="agent.id === defaultAgentId ? '默认助理不可删除' : '删除 Agent'"
                    :aria-label="`删除 ${agent.title}`"
                    @click="remove(agent)"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="loaded && !rows.length">
        {{ search ? '没有匹配的 Agent，请调整筛选条件。' : '暂无 Agent。' }}
      </p>
      <PaginationField
        v-model:page="page"
        :total="filtered.length"
        :page-size="20"
        :disabled="busy"
        class="agents-pagination"
        label="Agents 分页"
      />
    </section>
    <EditorDialog
      v-if="dialog"
      :title="editing ? `编辑 ${editing.title}` : '新建 Agent'"
      :busy="busy"
      @close="close"
      ><AgentForm
        :value="editing"
        :capabilities="capabilities"
        :busy="busy"
        :error="message"
        @dirty="dirty = $event"
        @save="save"
    /></EditorDialog>
  </div>
</template>
