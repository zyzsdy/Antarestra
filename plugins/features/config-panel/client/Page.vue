<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, toRaw } from 'vue'
import { parseDocument } from 'yaml'
import { feedbackKey, refreshExtensionsKey } from '@antarestra/webui/client'
import { EditorDialog } from '@antarestra/webui/components'
import { PlusIcon, ArrowPathIcon } from '@antarestra/webui/icons'
import { ApiError, useApi } from '@antarestra/webui/api'
import SchemaForm from './SchemaForm.vue'
import RestartAction from './RestartAction.vue'
import { supportsForm } from './types.js'
import type { Snapshot, Detail, Metadata, Operation, Instance, Settings } from './types.js'
const { api, run, busy, message, router, session } = useApi()
const feedback = inject(feedbackKey)!
const refreshExtensions = inject(refreshExtensionsKey)!
const snapshot = ref<Snapshot>()
const selected = ref('')
const detail = ref<Detail>()
const yaml = ref('{}')
const alias = ref('')
const enabled = ref(false)
const baseline = ref('')
const settings = ref<Settings>({
  initializationTimeoutMs: 90000,
  disposalTimeoutMs: 30000,
  supervision: 'internal',
})
const mode = ref('form')
const search = ref('')
const searchInput = ref<HTMLInputElement>()
const status = ref('')
const adding = ref(false)
const catalog = ref<Metadata[]>([])
const packageName = ref('')
const groupDialog = ref(false)
const groupId = ref('')
const groupName = ref('')
const collapsed = ref(new Set<string>())
const dragging = ref('')
let alive = true
let request = 0
const draft = () =>
  JSON.stringify(
    selected.value === '$loader' ? settings.value : [yaml.value, alias.value, enabled.value],
  )
const dirty = computed(() => !!selected.value && draft() !== baseline.value)
const parsed = computed(() => {
  try {
    const doc = parseDocument(yaml.value)
    if (doc.errors.length) return undefined
    const value: unknown = doc.toJS({ maxAliasCount: 0 })
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
})
const rows = computed(() =>
  (snapshot.value?.instances ?? [])
    .filter((row) =>
      `${row.alias} ${row.pluginId} ${row.instanceId}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    )
    .sort((a, b) => a.order - b.order),
)
const groups = computed(() => [
  { id: '', name: '未分组' },
  ...(snapshot.value?.layout.groups ?? []),
])
const current = computed(() =>
  snapshot.value?.instances.find((item) => item.instanceId === selected.value),
)
const names: Record<string, string> = {
  disabled: '未启用',
  active: '运行中',
  failed: '启动失败',
  loading: '初始化中',
  waiting: '等待依赖',
  unloading: '清理中',
}
const newAddress = computed(() => {
  if (!detail.value?.info?.name.endsWith('/plugin-server') || !parsed.value) return ''
  const config = parsed.value
  if (typeof config.publicUrl === 'string' && config.publicUrl && !config.publicUrl.startsWith('$'))
    return config.publicUrl
  const port = config.port ?? 14451
  if (typeof port !== 'number') return '地址包含环境变量，请按主配置确认新入口。'
  return `${config.https === true ? 'https' : 'http'}://${location.hostname}:${port}/admin/plugin-config-panel/`
})
function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}
function editGroup(id = '', name = '') {
  groupId.value = id
  groupName.value = name
  groupDialog.value = true
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的修改？', '切换后当前草稿将丢失。已保存的配置不受影响。'))
  )
}
async function refresh() {
  const data = await api<Snapshot>('/plugin-config-panel')
  if (!alive) return
  snapshot.value = data
}
async function select(id: string, skipConfirm = false) {
  if (!skipConfirm && !(await discard())) return
  const seq = ++request
  if (id === '$loader') {
    selected.value = id
    detail.value = undefined
    settings.value = structuredClone(toRaw(snapshot.value!.loader))
    baseline.value = draft()
    return
  }
  const data = await api<Detail>(`/plugin-config-panel/instances/${encodeURIComponent(id)}`)
  if (seq !== request || !alive) return
  selected.value = id
  detail.value = data
  yaml.value = data.yaml
  alias.value = snapshot.value?.layout.instances[id]?.alias ?? ''
  enabled.value = data.entry.enabled
  baseline.value = draft()
  mode.value = supportsForm(data.info?.schema) ? 'form' : 'yaml'
}
async function reload() {
  if (!(await discard())) return
  await refresh()
  if (
    selected.value &&
    (selected.value === '$loader' ||
      snapshot.value?.instances.some((row) => row.instanceId === selected.value))
  )
    await select(selected.value, true)
  else {
    selected.value = ''
    detail.value = undefined
  }
}
function field(path: string[], value: unknown, remove = false) {
  const document = parseDocument(yaml.value)
  if (document.errors.length) return
  if (remove) document.deleteIn(path)
  else document.setIn(path, value)
  yaml.value = document.toString()
}
async function operate(path: string, body: object, method = 'POST') {
  let operation = await api<Operation>(`/plugin-config-panel${path}`, body, method)
  const deadline = Date.now() + 120000
  while (alive && ['queued', 'running'].includes(operation.state)) {
    status.value = operation.saved ? '配置已保存，正在应用…' : '正在校验并执行…'
    await new Promise((resolve) => setTimeout(resolve, 350))
    try {
      operation = await api<Operation>(`/plugin-config-panel/operations/${operation.id}`)
    } catch (error) {
      if (!alive) return
      if (
        Date.now() >= deadline ||
        !(
          error instanceof TypeError ||
          (error instanceof ApiError && [404, 503].includes(error.status))
        )
      )
        throw error
      status.value = '管理入口暂时中断，正在等待恢复并查询原任务…'
    }
  }
  if (!alive) return
  if (operation.snapshot) snapshot.value = operation.snapshot
  status.value = operation.saved ? '配置已保存' : ''
  if (operation.state === 'failed') {
    if (operation.saved) {
      if (detail.value && operation.snapshot) detail.value.version = operation.snapshot.version
    }
    throw new Error(`${operation.saved ? '配置已保存，但应用未完成：' : ''}${operation.message}`)
  }
  feedback.toast('操作完成')
  status.value = ''
  await refreshExtensions()
}
async function save() {
  await run(async () => {
    if (selected.value === '$loader') {
      await operate(
        '/loader',
        { version: snapshot.value!.version, settings: settings.value },
        'PUT',
      )
      baseline.value = draft()
      status.value = '加载器配置已保存，下次重启生效'
      return
    }
    if (!parsed.value) throw new Error('配置必须是有效的 YAML 映射')
    if (
      !(await feedback.modal(
        '保存并应用插件配置？',
        `插件将按新配置重新加载，相关连接与内存状态可能中断。${detail.value?.impacts.length ? '\n受影响实例：' + detail.value.impacts.join('、') : ''}\n若管理入口不可用，请编辑主配置文件并重启恢复。${newAddress.value ? '\n新入口：' + newAddress.value : ''}`,
      ))
    )
      return
    await operate(
      `/instances/${encodeURIComponent(selected.value)}`,
      {
        version: detail.value!.version,
        yaml: yaml.value,
        alias: alias.value,
        enabled: enabled.value,
      },
      'PUT',
    )
    baseline.value = draft()
    await select(selected.value, true)
  })
}
async function remove() {
  await run(async () => {
    if (
      !(await feedback.modal(
        '删除插件配置？',
        `将立即卸载 ${current.value?.alias || selected.value}，依赖包仍保留。依赖它的插件可能停止工作。${detail.value?.impacts.length ? '\n受影响实例：' + detail.value.impacts.join('、') : ''}`,
      ))
    )
      return
    await operate(
      `/instances/${encodeURIComponent(selected.value)}`,
      { version: snapshot.value!.version },
      'DELETE',
    )
    selected.value = ''
    detail.value = undefined
  })
}
async function applyDisk() {
  await run(async () => {
    if (
      !(await discard()) ||
      !(await feedback.modal(
        '应用磁盘中的配置？',
        '将按已保存配置启停或重载该实例，相关服务可能中断。',
      ))
    )
      return
    await operate(`/instances/${encodeURIComponent(selected.value)}/apply`, {
      version: snapshot.value!.version,
    })
    if (snapshot.value?.instances.some((row) => row.instanceId === selected.value))
      await select(selected.value, true)
    else selected.value = ''
  })
}
async function beginAdd() {
  await run(async () => {
    catalog.value = await api<Metadata[]>('/plugin-config-panel/catalog')
    packageName.value = ''
    adding.value = true
  })
}
async function add() {
  await run(async () => {
    await operate('/instances', { version: snapshot.value!.version, name: packageName.value })
    adding.value = false
  })
}
async function move(row: Instance, group: string, delta = 0, before?: string) {
  await run(async () => {
    const layout = structuredClone(toRaw(snapshot.value!.layout))
    const ordered = snapshot
      .value!.instances.filter((item) => item.group === group && item.instanceId !== row.instanceId)
      .sort((a, b) => a.order - b.order)
    let index = before
      ? ordered.findIndex((item) => item.instanceId === before)
      : delta
        ? Math.max(
            0,
            Math.min(
              ordered.length,
              rows.value
                .filter((item) => item.group === group)
                .findIndex((item) => item.instanceId === row.instanceId) + delta,
            ),
          )
        : ordered.length
    if (index < 0) index = ordered.length
    ordered.splice(index, 0, row)
    ordered.forEach((item, order) => {
      layout.instances[item.instanceId] = { ...layout.instances[item.instanceId], group, order }
    })
    await operate('/layout', { version: snapshot.value!.version, layout }, 'PUT')
    if (detail.value) detail.value.version = snapshot.value!.version
  })
}
async function groupSave(removeGroup = false) {
  await run(async () => {
    const layout = structuredClone(toRaw(snapshot.value!.layout))
    const id = groupId.value || crypto.randomUUID()
    if (removeGroup) {
      if (!(await feedback.modal('删除分组？', '分组中的插件移入未分组，不删除插件配置。'))) return
      layout.groups = layout.groups.filter((group) => group.id !== id)
      for (const item of Object.values(layout.instances)) if (item.group === id) item.group = ''
    } else {
      if (!groupName.value.trim()) throw new Error('请输入分组名称')
      const existing = layout.groups.find((group) => group.id === id)
      if (existing) existing.name = groupName.value.trim()
      else layout.groups.push({ id, name: groupName.value.trim() })
    }
    await operate('/layout', { version: snapshot.value!.version, layout }, 'PUT')
    groupDialog.value = false
    if (detail.value) detail.value.version = snapshot.value!.version
  })
}
async function moveGroup(id: string, direction: number) {
  await run(async () => {
    const layout = structuredClone(toRaw(snapshot.value!.layout))
    const index = layout.groups.findIndex((group) => group.id === id)
    const next = index + direction
    if (next < 0 || next >= layout.groups.length) return
    const [group] = layout.groups.splice(index, 1)
    layout.groups.splice(next, 0, group!)
    await operate('/layout', { version: snapshot.value!.version, layout }, 'PUT')
    if (detail.value) detail.value.version = snapshot.value!.version
  })
}
function drop(group: string, before?: string) {
  const row = snapshot.value?.instances.find((item) => item.instanceId === dragging.value)
  dragging.value = ''
  if (row && !busy.value) void move(row, group, 0, before)
}
const stopGuard = router.beforeEach(async () => await discard())
const unload = (event: BeforeUnloadEvent) => {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onMounted(() => {
  void run(() => refresh())
  window.addEventListener('beforeunload', unload)
})
onUnmounted(() => {
  alive = false
  stopGuard()
  window.removeEventListener('beforeunload', unload)
})
</script>
<template>
  <section class="config-page">
    <header class="page-heading">
      <p>管理插件配置与运行状态</p>
      <RestartAction
        :before-open="discard"
        v-if="session.snapshot.value?.permissions.includes('admin.system.restart')"
      />
    </header>
    <p v-if="message" class="error" role="alert">{{ message }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="!snapshot" role="status">正在读取插件配置…</p>
    <div v-else class="split" :class="{ 'has-selection': selected }">
      <aside class="plugin-list" aria-label="插件实例">
        <div class="list-tools">
          <button :disabled="busy" @click="beginAdd">
            <PlusIcon class="ui-icon" aria-hidden="true" />添加插件</button
          ><button :disabled="busy" aria-label="刷新配置" title="刷新配置" @click="run(reload)">
            <ArrowPathIcon class="ui-icon" aria-hidden="true" />
          </button>
        </div>
        <div class="search">
          <label class="sr-only" for="plugin-search">搜索插件</label
          ><input
            id="plugin-search"
            ref="searchInput"
            v-model="search"
            placeholder="搜索插件或别名"
          /><button v-if="search" aria-label="清空搜索" @click="clearSearch">清空</button>
        </div>
        <button
          class="loader-link"
          :class="{ selected: selected === '$loader' }"
          :disabled="busy"
          @click="run(() => select('$loader'))"
        >
          加载器设置 <span>重启生效</span>
        </button>
        <div class="groups-heading">
          <span>{{ rows.length }} 个配置实例</span
          ><button :disabled="busy" @click="editGroup()">新建分组</button>
        </div>
        <section
          v-for="group in groups"
          :key="group.id"
          class="plugin-group"
          @dragover.prevent
          @drop.prevent.stop="drop(group.id)"
        >
          <div class="group-heading">
            <button
              :aria-expanded="!collapsed.has(group.id)"
              @click="
                collapsed.has(group.id) ? collapsed.delete(group.id) : collapsed.add(group.id)
              "
            >
              {{ collapsed.has(group.id) ? '展开' : '收起' }} · {{ group.name }}</button
            ><template v-if="group.id"
              ><button
                :disabled="busy"
                :aria-label="`上移分组 ${group.name}`"
                @click="moveGroup(group.id, -1)"
              >
                上移</button
              ><button
                :disabled="busy"
                :aria-label="`下移分组 ${group.name}`"
                @click="moveGroup(group.id, 1)"
              >
                下移</button
              ><button
                :disabled="busy"
                :aria-label="`编辑分组 ${group.name}`"
                @click="editGroup(group.id, group.name)"
              >
                编辑
              </button></template
            >
          </div>
          <ul v-show="!collapsed.has(group.id)">
            <li
              v-for="row in rows.filter((item) => item.group === group.id)"
              :key="row.instanceId"
              :draggable="!busy"
              @dragstart="dragging = row.instanceId"
              @dragend="dragging = ''"
              @dragover.prevent
              @drop.prevent.stop="drop(group.id, row.instanceId)"
            >
              <button
                class="instance"
                :class="{ selected: selected === row.instanceId }"
                :aria-current="selected === row.instanceId ? 'true' : undefined"
                :disabled="busy"
                @click="run(() => select(row.instanceId))"
              >
                <span class="dot" :class="row.status" aria-hidden="true" /><span
                  class="instance-text"
                  ><strong>{{ row.alias || row.pluginId }}</strong
                  ><small
                    >{{ names[row.status] }}{{ row.pending ? ' · 待应用' : ''
                    }}{{ row.removed ? ' · 待移除' : '' }}</small
                  ></span
                >
              </button>
            </li>
          </ul>
        </section>
        <p v-if="!rows.length" class="empty">
          {{ search ? '没有匹配的插件。' : '尚未添加插件配置。' }}
        </p>
      </aside>
      <main class="details" aria-label="配置详情" :aria-busy="busy">
        <button
          v-if="selected"
          class="back"
          :disabled="busy"
          @click="
            run(async () => {
              if (await discard()) selected = ''
            })
          "
        >
          返回插件列表
        </button>
        <div v-if="!selected" class="empty">
          <h2>选择一个插件</h2>
          <p>查看运行状态，编辑配置并单独加载。</p>
        </div>
        <form v-else-if="selected === '$loader'" novalidate @submit.prevent="save">
          <h2>加载器设置</h2>
          <p>加载器是系统固定入口，不能停用或删除。修改仅在下次重启后生效。</p>
          <label for="init-timeout">初始化超时（毫秒）</label
          ><input
            id="init-timeout"
            v-model.number="settings.initializationTimeoutMs"
            type="number"
            min="1"
          />
          <label for="dispose-timeout">清理超时（毫秒）</label
          ><input
            id="dispose-timeout"
            v-model.number="settings.disposalTimeoutMs"
            type="number"
            min="1"
          />
          <label for="supervision">进程监督模式</label
          ><select id="supervision" v-model="settings.supervision">
            <option value="internal">内部监督 · 自动拉起新进程</option>
            <option value="external">外部监督 · 退出码 75</option>
          </select>
          <p v-if="settings.supervision === 'external'" class="notice">
            请确保部署平台收到退出码 75 后重新启动服务。
          </p>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy">保存加载器设置</button>
          </div>
        </form>
        <form v-else-if="detail" novalidate @submit.prevent="save">
          <header class="detail-heading">
            <div>
              <h2>{{ alias || detail.entry.pluginId }}</h2>
              <code>{{ selected }}</code>
            </div>
            <span class="state-label">{{ names[current?.status ?? 'failed'] }}</span>
          </header>
          <p v-if="current?.error" class="error" role="alert">{{ current.error }}</p>
          <div v-if="current?.pending" class="notice">
            磁盘配置与当前运行实例不一致。<button type="button" :disabled="busy" @click="applyDisk">
              应用磁盘配置
            </button>
          </div>
          <p class="muted">
            {{ detail.info?.name || detail.entry.pluginId }} {{ detail.info?.version
            }}{{ detail.info?.multipleInstances ? ' · 支持多实例' : ' · 单实例' }}
          </p>
          <label for="plugin-alias">别名</label
          ><input
            id="plugin-alias"
            v-model="alias"
            maxlength="120"
            placeholder="可选，用于列表显示"
          />
          <div class="instance-controls">
            <label><input v-model="enabled" type="checkbox" /> 启用插件（保存后生效）</label>
            <div v-if="current">
              <button type="button" :disabled="busy" @click="move(current, current.group, -1)">
                上移</button
              ><button type="button" :disabled="busy" @click="move(current, current.group, 1)">
                下移
              </button>
            </div>
          </div>
          <label for="instance-group">所属分组</label
          ><select
            id="instance-group"
            :value="current?.group ?? ''"
            :disabled="busy"
            @change="current && move(current, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="group in groups" :key="group.id" :value="group.id">
              {{ group.name }}
            </option>
          </select>
          <div class="editor-tabs" role="group" aria-label="配置编辑方式">
            <button
              type="button"
              :aria-pressed="mode === 'form'"
              :disabled="!supportsForm(detail.info?.schema) || !parsed"
              @click="mode = 'form'"
            >
              自动表单</button
            ><button type="button" :aria-pressed="mode === 'yaml'" @click="mode = 'yaml'">
              YAML
            </button>
          </div>
          <p class="muted">环境变量保留为 $变量名；禁用时可以保存未完成配置。</p>
          <SchemaForm
            v-if="mode === 'form' && detail.info?.schema && parsed"
            :schema="detail.info.schema"
            :value="parsed"
            @change="field"
          />
          <template v-else
            ><label for="plugin-yaml">插件配置 YAML</label
            ><textarea
              id="plugin-yaml"
              style="resize: none"
              v-model="yaml"
              spellcheck="false"
              :aria-invalid="!parsed"
              aria-describedby="yaml-help"
            />
            <p id="yaml-help" :class="{ error: !parsed }">
              {{
                parsed
                  ? '仅编辑当前插件配置；主配置其他部分保持不变。'
                  : '请输入有效的 YAML 映射，不支持别名及重复键。'
              }}
            </p></template
          >
          <p v-if="newAddress" class="notice">
            监听配置变更后请手动打开：<code>{{ newAddress }}</code>
          </p>
          <div class="actions">
            <button type="submit" class="primary" :disabled="busy || current?.removed">
              {{ busy ? '正在处理…' : '保存并应用' }}</button
            ><span v-if="dirty" class="muted">有未保存修改</span
            ><button type="button" class="danger" :disabled="busy" @click="remove">删除配置</button>
          </div>
        </form>
      </main>
    </div>
    <EditorDialog v-if="adding" title="添加已安装的插件" :busy="busy" @close="adding = false"
      ><form novalidate @submit.prevent="add">
        <p>只添加配置，不安装依赖。新实例初始为禁用状态。</p>
        <label for="package-name">插件包</label
        ><select id="package-name" v-model="packageName">
          <option value="">请选择插件</option>
          <option v-for="item in catalog" :key="item.name" :value="item.name">
            {{ item.name }} {{ item.multipleInstances ? '（可多实例）' : '' }}
          </option>
        </select>
        <p v-if="!catalog.length">
          未发现可添加插件，请先在服务端安装带有 antarestra-plugin 标记的依赖包。
        </p>
        <p v-if="message" class="error" role="alert">{{ message }}</p>
        <div class="actions">
          <button type="submit" class="primary" :disabled="busy || !packageName">添加配置</button>
        </div>
      </form></EditorDialog
    >
    <EditorDialog
      v-if="groupDialog"
      :title="groupId ? '编辑分组' : '新建分组'"
      :busy="busy"
      @close="groupDialog = false"
      ><form novalidate @submit.prevent="groupSave()">
        <label for="group-name">分组名称</label
        ><input id="group-name" v-model="groupName" maxlength="80" />
        <p v-if="message" class="error" role="alert">{{ message }}</p>
        <div class="actions">
          <button type="submit" class="primary" :disabled="busy">保存分组</button
          ><button
            v-if="groupId"
            type="button"
            class="danger"
            :disabled="busy"
            @click="groupSave(true)"
          >
            删除分组
          </button>
        </div>
      </form></EditorDialog
    >
  </section>
</template>
<style>
.config-page {
  color: #263047;
}
.config-page h1 {
  margin: 0;
  font-size: 27px;
}
.config-page h2 {
  margin: 0 0 12px;
  font-size: 20px;
  overflow-wrap: anywhere;
}
.config-page p {
  line-height: 1.6;
}
.config-page button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid #d8dee9;
  border-radius: 7px;
  background: #fff;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.config-page button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.config-page input:not([type='checkbox']),
.config-page select,
.config-page textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #d8dee9;
  border-radius: 7px;
  background: white;
  color: inherit;
  font: inherit;
}
.config-page form > label {
  display: block;
  margin: 20px 0 8px;
}
.config-page textarea {
  min-height: 360px;
  resize: none;
  overflow: auto;
  font-family: Consolas, monospace;
  line-height: 1.6;
}
.config-page code {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.config-page .page-heading,
.config-page .detail-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}
.config-page .page-heading p {
  margin: 8px 0 0;
  color: #667085;
}
.config-page .split {
  display: grid;
  grid-template-columns: minmax(240px, 30%) minmax(0, 1fr);
  border: 1px solid #e0e6ef;
  background: white;
  border-radius: 12px;
  overflow: hidden;
}
.config-page .plugin-list {
  background: #f8fafd;
  padding: 16px;
  border-right: 1px solid #e0e6ef;
  min-width: 0;
}
.config-page .details {
  padding: 28px;
  min-width: 0;
}
.config-page .list-tools,
.config-page .search,
.config-page .groups-heading,
.config-page .group-heading,
.config-page .instance-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.config-page .search {
  margin: 14px 0;
}
.config-page .groups-heading {
  margin: 20px 0 12px;
  font-size: 12px;
}
.config-page .group-heading {
  flex-wrap: wrap;
  margin: 12px 0 4px;
}
.config-page .group-heading button {
  padding: 5px;
  border: 0;
  background: transparent;
  font-size: 12px;
}
.config-page .group-heading button:first-child {
  margin-right: auto;
  font-weight: 600;
}
.config-page ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.config-page .instance {
  width: 100%;
  border: 0;
  background: transparent;
  justify-content: flex-start;
  padding: 12px 9px;
  text-align: left;
}
.config-page .selected {
  background: #e9efff;
  color: #315ed1;
}
.config-page .instance.selected {
  background: #e9efff;
}
.config-page .instance-text {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.config-page .instance-text strong {
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.config-page .instance-text small {
  color: #667085;
  font-size: 11px;
}
.config-page .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
  background: #9199a8;
}
.config-page .dot.active {
  background: #218458;
}
.config-page .dot.failed {
  background: #ca3c43;
}
.config-page .dot.loading,
.config-page .dot.waiting,
.config-page .dot.unloading {
  background: #b07813;
}
.config-page .loader-link {
  width: 100%;
  justify-content: space-between;
}
.config-page .loader-link span,
.config-page .muted {
  color: #667085;
  font-size: 12px;
}
.config-page .state-label {
  white-space: nowrap;
  font-size: 12px;
  background: #f4f6fa;
  padding: 7px 10px;
  border-radius: 7px;
}
.config-page .instance-controls {
  margin: 20px 0;
}
.config-page .editor-tabs {
  display: flex;
  gap: 8px;
  padding-top: 24px;
  margin-top: 24px;
  border-top: 1px solid #e4e9f1;
}
.config-page .editor-tabs [aria-pressed='true'] {
  color: #315ed1;
  border-color: #315ed1;
}
.config-page .actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}
.config-page .primary {
  background: #315ed1;
  border-color: #315ed1;
  color: white;
  min-width: 120px;
}
.config-page .danger {
  color: #ae3038;
  margin-left: auto;
}
.config-page .error {
  background: #fff1f2;
  color: #a22e36;
  border-radius: 7px;
  padding: 12px;
  overflow-wrap: anywhere;
}
.config-page .notice {
  padding: 12px;
  background: #f4f6fa;
  border: 1px solid #d8dee9;
  border-radius: 7px;
  margin-bottom: 16px;
  line-height: 1.7;
}
.config-page .empty {
  padding: 35px 10px;
  color: #667085;
}
.config-page .back {
  display: none;
}
.config-page .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (max-width: 760px) {
  .config-page h1 {
    font-size: 23px;
  }
  .config-page .split {
    grid-template-columns: minmax(0, 1fr);
  }
  .config-page .details {
    display: none;
    padding: 18px;
  }
  .config-page .has-selection .details {
    display: block;
  }
  .config-page .has-selection .plugin-list {
    display: none;
  }
  .config-page .back {
    display: inline-flex;
    margin-bottom: 20px;
  }
  .config-page .page-heading {
    flex-wrap: wrap;
  }
  .config-page .detail-heading {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
