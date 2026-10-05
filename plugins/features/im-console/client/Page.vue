<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import { EditorDialog, PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import type { ConnectionPolicy, ConnectionSnapshot } from '@antarestra/im'
import PolicyForm from './PolicyForm.vue'
import './style.css'

const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const connections = ref<ConnectionSnapshot[]>([])
const loaded = ref(false)
const search = ref('')
const page = ref(1)
const editing = ref<ConnectionSnapshot>()
const policy = ref<ConnectionPolicy>()
const revision = ref(0)
const dialog = ref(false)
const dirty = ref(false)
let alive = true
const states = { connecting: '连接中', online: '已连接', offline: '未连接', error: '连接异常' }
const filtered = computed(() =>
  connections.value.filter((item) =>
    `${item.label ?? ''} ${item.id} ${item.platform} ${item.accountId}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
watch(search, () => {
  page.value = 1
})
async function load() {
  const data = await api<{ connections: ConnectionSnapshot[] }>('/im/connections')
  if (!alive) return
  connections.value = data.connections
  loaded.value = true
  page.value = Math.min(page.value, pages.value)
}
async function edit(connection: ConnectionSnapshot) {
  const data = await api<{ policy: ConnectionPolicy; revision: number }>(
    `/im/connections/${encodeURIComponent(connection.id)}/policy`,
  )
  if (!alive) return
  editing.value = connection
  policy.value = data.policy
  revision.value = data.revision
  dirty.value = false
  dialog.value = true
}
async function discard() {
  return (
    !dirty.value ||
    (await feedback.modal('放弃未保存的聊天规则？', '当前修改将丢失，已保存的规则不受影响。'))
  )
}
async function close() {
  if (busy.value || !(await discard())) return
  dialog.value = dirty.value = false
  message.value = ''
}
async function save(value: ConnectionPolicy) {
  if (!editing.value) return
  await run(async () => {
    if (
      !(await feedback.modal(
        `保存“${editing.value!.label ?? editing.value!.id}”的聊天规则？`,
        '修改立即影响该接入的消息准入、收发消息、普通命令与 AI 激活。',
      ))
    )
      return
    const data = await api<{ policy: ConnectionPolicy; revision: number }>(
      `/im/connections/${encodeURIComponent(editing.value!.id)}/policy`,
      { policy: value, revision: revision.value },
      'PUT',
    )
    if (!alive) return
    policy.value = data.policy
    revision.value = data.revision
    dirty.value = false
    dialog.value = false
    feedback.toast('聊天规则已保存')
  })
}
async function reloadPolicy() {
  if (editing.value && (await discard())) await edit(editing.value)
}
const removeGuard = router.beforeEach(async () => !busy.value && (await discard()))
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
  removeGuard()
  window.removeEventListener('beforeunload', unload)
})
</script>

<template>
  <div class="im-page">
    <div class="im-toolbar">
      <p class="im-hint">连接机器人账号，为每个群和私聊设置独立的消息规则。</p>
      <button :disabled="busy" aria-label="刷新 IM 接入" title="刷新 IM 接入" @click="run(load)">
        <ArrowPathIcon class="ui-icon" />
      </button>
    </div>
    <p class="im-panel im-hint">
      接入账号与凭据在“插件设置”中配置。这里管理聊天准入与 AI；关闭 AI 后，普通命令仍可使用。
    </p>
    <p v-if="message && !dialog" class="im-error" role="alert">{{ message }}</p>
    <section class="im-panel" :aria-busy="busy">
      <div class="im-toolbar">
        <label for="im-search">筛选接入</label
        ><input id="im-search" v-model="search" placeholder="名称、平台或账号 ID" />
        <button v-if="search" @click="search = ''">清空筛选</button
        ><span role="status">共 {{ filtered.length }} 个</span>
      </div>
      <p v-if="!loaded" role="status">
        {{ busy ? '正在加载 IM 接入…' : '加载未完成，请刷新重试。' }}
      </p>
      <p v-else-if="!connections.length" class="im-hint">
        尚未启用 IM 适配器。请在插件设置中启用 OneBot 或飞书接入。
      </p>
      <p v-else-if="!rows.length" role="status">没有匹配的接入，请调整筛选条件。</p>
      <div v-else class="im-table">
        <table>
          <thead>
            <tr>
              <th>接入</th>
              <th>机器人账号</th>
              <th>连接状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in rows" :key="item.id">
              <td>
                <strong>{{ item.label || item.id }}</strong
                ><small>{{ item.platform }} · {{ item.id }}</small>
              </td>
              <td>
                {{ item.accountId }}<small v-if="item.tenantId">租户 {{ item.tenantId }}</small>
              </td>
              <td>
                {{ states[item.status]
                }}<small v-if="item.error" class="im-error">{{ item.error }}</small>
              </td>
              <td><button :disabled="busy" @click="run(() => edit(item))">配置聊天规则</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationField
        v-if="pages > 1"
        v-model:page="page"
        :total="filtered.length"
        :page-size="20"
        :disabled="busy"
        label="IM 接入分页"
      />
    </section>
    <EditorDialog
      v-if="dialog"
      :title="`${editing?.label || editing?.id || ''} · 聊天规则`"
      :busy="busy"
      class="im-editor"
      @close="close"
    >
      <p v-if="message" class="im-error" role="alert">
        {{ message }}<button :disabled="busy" @click="run(reloadPolicy)">重新读取规则</button>
      </p>
      <PolicyForm
        v-if="policy"
        :key="`${editing?.id}:${revision}`"
        :policy="policy"
        :busy="busy"
        @dirty="dirty = true"
        @save="save"
      />
      <template #footer
        ><button :disabled="busy" @click="close">取消</button
        ><button form="im-policy-form" type="submit" class="im-primary" :disabled="busy">
          保存聊天规则
        </button></template
      >
    </EditorDialog>
  </div>
</template>
