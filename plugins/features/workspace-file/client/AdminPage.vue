<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog, NumberField, PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import { bytes } from './format.js'
import './style.css'
interface Row {
  id: string
  label: string
  revision: number
  used: number
  reserved: number
  quota: number
}
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const rows = ref<Row[]>([]),
  total = ref(0),
  page = ref(Number(router.currentRoute.value.query.page) || 1)
const search = ref(String(router.currentRoute.value.query.search ?? ''))
const committed = ref(search.value),
  loaded = ref(false),
  editing = ref<Row>(),
  quota = ref(0)
async function load(next = page.value) {
  const result = await api<{ entries: Row[]; total: number; page: number }>(
    `/workspace-file-admin?page=${next}&search=${encodeURIComponent(committed.value)}`,
  )
  rows.value = result.entries
  total.value = result.total
  page.value = result.page
  loaded.value = true
  await router.replace({
    query: { search: committed.value || undefined, page: page.value > 1 ? page.value : undefined },
  })
}
function find() {
  committed.value = search.value
  void run(() => load(1))
}
function edit(row: Row) {
  editing.value = row
  quota.value = row.quota
  message.value = ''
}
async function close() {
  if (busy.value) return
  if (
    editing.value &&
    quota.value !== editing.value.quota &&
    !(await feedback.modal('放弃配额修改？', '尚未保存的配额将丢失。'))
  )
    return
  editing.value = undefined
  message.value = ''
}
function save() {
  void run(async () => {
    if (!editing.value) return
    if (!Number.isSafeInteger(quota.value) || quota.value < 0)
      throw new Error('请输入有效的非负整数字节数')
    await api(
      '/workspace-file-admin/quota',
      { workspaceId: editing.value.id, quota: quota.value, revision: editing.value.revision },
      'PUT',
    )
    editing.value = undefined
    feedback.toast('存储配额已保存')
    await load()
  })
}
onMounted(() => {
  void run(() => load())
})
const stopGuard = router.beforeEach(async (to, from) => {
  if (to.path === from.path) return true
  if (busy.value) return false
  if (editing.value && quota.value !== editing.value.quota)
    return feedback.modal('放弃配额修改？', '尚未保存的配额将丢失。')
  return true
})
onUnmounted(stopGuard)
</script>
<template>
  <section class="files-ui files-admin">
    <header class="files-heading">
      <div>
        <p>按工作空间管理容量，已用空间与上传预占分别统计。</p>
      </div>
      <button
        :disabled="busy"
        aria-label="刷新空间列表"
        title="刷新空间列表"
        @click="run(() => load())"
      >
        <ArrowPathIcon class="ui-icon" />
      </button>
    </header>
    <form class="files-toolbar" novalidate @submit.prevent="find">
      <label for="space-search">查找空间</label
      ><input
        id="space-search"
        v-model="search"
        placeholder="用户名、来源或空间 ID"
        :disabled="busy"
      /><button :disabled="busy">查询</button>
    </form>
    <p v-if="message && !editing" role="alert" class="files-error">
      {{ message }} <button :disabled="busy" @click="run(() => load())">重试</button>
    </p>
    <div class="files-panel" :aria-busy="busy">
      <p v-if="!loaded">{{ busy ? '正在加载空间…' : '尚未加载空间，请重试。' }}</p>
      <div v-else class="files-table">
        <table>
          <thead>
            <tr>
              <th>工作空间</th>
              <th>已用容量</th>
              <th>上传预占</th>
              <th>配额</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>
                <strong>{{ row.label }}</strong
                ><small>{{ row.id }}</small>
              </td>
              <td>{{ bytes(row.used) }}</td>
              <td>{{ bytes(row.reserved) }}</td>
              <td>
                {{ bytes(row.quota)
                }}<small v-if="row.used + row.reserved > row.quota">已超过配额，暂停新上传</small>
              </td>
              <td><button :disabled="busy" @click="edit(row)">修改配额</button></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="5">
                {{
                  committed
                    ? '没有匹配的空间，请修改查询条件。'
                    : '暂无空间，创建用户或从已授权入口访问文件后会出现在这里。'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="files-pagination">
        <span>共 {{ total }} 个空间</span
        ><PaginationField
          :page="page"
          :total="total"
          :page-size="20"
          :disabled="busy"
          label="工作空间分页"
          @update:page="run(() => load($event))"
        />
      </div>
    </div>
    <EditorDialog v-if="editing" title="修改存储配额" :busy="busy" @close="close">
      <form id="quota-form" novalidate @submit.prevent="save">
        <p>
          <strong>{{ editing.label }}</strong
          ><small>{{ editing.id }}</small>
        </p>
        <label for="quota">配额（字节）</label
        ><NumberField
          id="quota"
          v-model="quota"
          :min="0"
          :max="Number.MAX_SAFE_INTEGER"
          :disabled="busy"
          aria-describedby="quota-help"
        />
        <p id="quota-help">
          {{ bytes(quota) }}。设为 0 可停止新上传；降低配额不会删除已有文件，已预占的上传仍可完成。
        </p>
        <p v-if="message" role="alert" class="files-error">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="close">取消</button
        ><button class="primary" form="quota-form" :disabled="busy">保存配额</button></template
      >
    </EditorDialog>
  </section>
</template>
