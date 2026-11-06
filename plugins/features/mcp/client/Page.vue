<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowPathIcon, PlusIcon } from '@antarestra/webui/icons'
import { EditorDialog, PaginationField } from '@antarestra/webui/components'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import type { ServerInput, ServerView } from '../src/types.js'
import ServerForm from './ServerForm.vue'
import './style.css'
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const servers = ref<ServerView[]>([])
const loaded = ref(false)
const dialog = ref(false)
const editing = ref<ServerView>()
const dirty = ref(false)
const selected = ref<ServerView>()
const toolPage = ref(1)
const search = ref('')
const searchInput = ref<HTMLInputElement>()
const page = ref(1)
function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}
function showTools(server: ServerView) {
  selected.value = server
  toolPage.value = 1
}
const filtered = computed(() =>
  servers.value.filter((server) =>
    `${server.name} ${server.description}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
const statuses = {
  disabled: '已停用',
  connecting: '连接中',
  connected: '已连接',
  error: '连接失败',
}
const transports = { local: 'Local', 'streamable-http': 'Streamable HTTP', sse: 'SSE' }
watch(search, () => {
  page.value = 1
})
let alive = true
async function load() {
  const result = await api<ServerView[]>('/mcp')
  if (!alive) return
  servers.value = result
  loaded.value = true
  page.value = Math.min(page.value, Math.max(1, Math.ceil(filtered.value.length / 20)))
}
function edit(value?: ServerView) {
  editing.value = value
  dirty.value = false
  message.value = ''
  dialog.value = true
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的修改？', '当前输入将丢失，已保存的 MCP 配置不受影响。'))
  )
}
async function close() {
  if (busy.value || !(await discard())) return
  dialog.value = dirty.value = false
  message.value = ''
}
function update(value: ServerView) {
  const index = servers.value.findIndex((server) => server.id === value.id)
  if (index < 0) servers.value.push(value)
  else servers.value[index] = value
}
function save(value: ServerInput) {
  void run(async () => {
    const saved = await api<ServerView>(
      '/mcp' + (editing.value ? '/' + encodeURIComponent(editing.value.id) : ''),
      value,
      editing.value ? 'PUT' : 'POST',
    )
    if (!alive) return
    update(saved)
    dialog.value = dirty.value = false
    feedback.toast(
      saved.status === 'error'
        ? '配置已保存，连接失败。请查看服务器状态并重试。'
        : 'MCP 服务器已保存',
    )
  })
}
function reconnect(value: ServerView) {
  void run(async () => {
    const saved = await api<ServerView>(`/mcp/${encodeURIComponent(value.id)}/reconnect`, {
      revision: value.revision,
    })
    if (!alive) return
    update(saved)
    feedback.toast(
      saved.status === 'connected' ? 'MCP 服务器已重新连接' : '连接失败，请检查服务器配置后重试。',
    )
  })
}
function remove(value: ServerView) {
  void run(async () => {
    if (
      !(await feedback.modal(
        `删除 MCP 服务器“${value.name}”？`,
        '将删除连接配置、关闭连接并卸载这组工具。被覆盖的同名工具会恢复；使用已卸载工具的运行可能中断。此操作不能撤销。',
        { confirmLabel: '删除服务器', danger: true },
      ))
    )
      return
    await api(`/mcp/${encodeURIComponent(value.id)}`, { revision: value.revision }, 'DELETE')
    if (!alive) return
    servers.value = servers.value.filter((server) => server.id !== value.id)
    page.value = Math.min(page.value, Math.max(1, Math.ceil(filtered.value.length / 20)))
    feedback.toast('MCP 服务器已删除')
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
  <div class="mcp-page">
    <header class="mcp-heading">
      <p>连接 MCP 服务器，将外部工具提供给助理。</p>
      <div class="mcp-actions">
        <button
          :disabled="busy"
          aria-label="刷新 MCP 服务器"
          title="刷新 MCP 服务器"
          @click="run(load)"
        >
          <ArrowPathIcon class="ui-icon" aria-hidden="true" />
        </button>
        <button class="mcp-primary" :disabled="busy || !loaded" @click="edit()">
          <PlusIcon class="ui-icon" aria-hidden="true" />添加服务器
        </button>
      </div>
    </header>
    <p class="mcp-hint mcp-banner">
      同名工具由后注册者覆盖，包括内置工具；启用前缀可让工具并存。重连或更新工具列表会重新注册。停用或删除后恢复上一有效实现。
    </p>
    <p v-if="message && !dialog" class="mcp-error" role="alert">{{ message }}</p>
    <section class="mcp-panel" :aria-busy="busy">
      <div class="mcp-toolbar">
        <label for="mcp-search">筛选服务器</label
        ><input
          id="mcp-search"
          ref="searchInput"
          v-model="search"
          placeholder="名称或描述"
        /><button v-if="search" @click="clearSearch">清空筛选</button
        ><span role="status">共 {{ filtered.length }} 个</span>
      </div>
      <p class="mcp-loading" role="status">{{ busy ? '正在处理，请稍候…' : '' }}</p>
      <p v-if="!loaded && !busy" role="status">加载未完成，请刷新重试。</p>
      <div v-if="loaded" class="mcp-table">
        <table>
          <thead>
            <tr>
              <th>服务器</th>
              <th>连接方式</th>
              <th>状态</th>
              <th>工具</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="server in rows" :key="server.id">
              <td>
                <strong>{{ server.name }}</strong
                ><small>{{ server.description || '未填写描述' }}</small
                ><small v-if="server.prefixEnabled"
                  >前缀：<code>{{ server.prefix }}</code></small
                >
              </td>
              <td>{{ transports[server.transport] }}</td>
              <td>
                <span :class="['mcp-status', server.status]">{{ statuses[server.status] }}</span
                ><small v-if="server.error" class="mcp-error">{{ server.error }}</small>
              </td>
              <td>
                <button
                  :disabled="busy"
                  :aria-label="`查看 ${server.name} 的工具`"
                  @click="showTools(server)"
                >
                  {{ server.tools.length }} 个工具
                </button>
              </td>
              <td>
                <div class="mcp-actions">
                  <button
                    :disabled="busy"
                    :aria-label="`编辑 ${server.name}`"
                    @click="edit(server)"
                  >
                    编辑</button
                  ><button
                    :disabled="busy || !server.enabled"
                    :aria-label="`重连 ${server.name}`"
                    @click="reconnect(server)"
                  >
                    重连</button
                  ><button
                    class="mcp-danger"
                    :disabled="busy"
                    :aria-label="`删除 ${server.name}`"
                    @click="remove(server)"
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
        {{
          search
            ? '没有匹配的服务器，请调整筛选条件。'
            : '尚未添加 MCP 服务器。点击“添加服务器”开始连接。'
        }}
      </p>
      <PaginationField
        v-model:page="page"
        :total="filtered.length"
        :page-size="20"
        :disabled="busy"
        class="mcp-pagination"
        label="MCP 服务器分页"
      />
    </section>
    <EditorDialog
      v-if="dialog"
      :title="editing ? `编辑 ${editing.name}` : '添加 MCP 服务器'"
      :busy="busy"
      @close="close"
    >
      <ServerForm
        :value="editing"
        :busy="busy"
        :error="message"
        @dirty="dirty = $event"
        @save="save"
      />
      <template #footer
        ><button
          class="mcp-primary"
          type="submit"
          form="mcp-editor-form"
          :disabled="busy"
          :aria-busy="busy"
        >
          保存服务器
        </button></template
      >
    </EditorDialog>
    <EditorDialog v-if="selected" :title="`${selected.name} 的工具`" @close="selected = undefined">
      <p class="mcp-hint">这里显示此连接提供的工具。同名工具最终由最后注册的有效实现提供。</p>
      <p v-if="selected.activationDescription">
        <strong>激活描述：</strong>{{ selected.activationDescription }}
      </p>
      <p v-if="!selected.tools.length">暂无工具。请启用服务器并确认连接成功。</p>
      <ul class="mcp-tools">
        <li v-for="tool in selected.tools.slice((toolPage - 1) * 20, toolPage * 20)" :key="tool.id">
          <code>{{ tool.id }}</code
          ><small v-if="tool.id !== tool.name">原名称：{{ tool.name }}</small>
          <p>{{ tool.description || '未提供工具描述' }}</p>
        </li>
      </ul>
      <PaginationField
        v-model:page="toolPage"
        :total="selected.tools.length"
        :page-size="20"
        label="MCP 工具分页"
      />
    </EditorDialog>
  </div>
</template>
