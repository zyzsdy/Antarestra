<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog, PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon, FolderIcon, DocumentIcon, ArrowUpTrayIcon } from '@antarestra/webui/icons'
import type { WorkspaceFilesClient } from './api.js'
import { uploadPath } from './api.js'
import { bytes } from './format.js'
import './style.css'
const props = defineProps<{ files: WorkspaceFilesClient }>()
interface Entry {
  path: string
  kind: 'file' | 'directory'
  size: number
}
const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const path = ref(String(router.currentRoute.value.query.path ?? '/'))
const page = ref(Number(router.currentRoute.value.query.page) || 1),
  total = ref(0),
  rows = ref<Entry[]>([])
const used = ref(0),
  reserved = ref(0),
  quota = ref(0),
  loaded = ref(false)
const picker = ref<HTMLInputElement>(),
  percent = ref<number>(),
  uploading = ref(false)
let controller: AbortController | undefined
const editor = ref<'directory' | 'move'>(),
  original = ref(''),
  target = ref('')
const crumbs = computed(() => [
  { label: '根目录', path: '/' },
  ...path.value
    .split('/')
    .filter(Boolean)
    .map((label, i, all) => ({ label, path: '/' + all.slice(0, i + 1).join('/') })),
])
async function load(next = path.value, nextPage = page.value) {
  const result = await api<{
    path: string
    page: number
    entries: Entry[]
    total: number
    used: number
    reserved: number
    quota: number
  }>(`/workspace-files?path=${encodeURIComponent(next)}&page=${nextPage}`)
  path.value = result.path
  page.value = result.page
  total.value = result.total
  rows.value = result.entries
  used.value = result.used
  reserved.value = result.reserved
  quota.value = result.quota
  loaded.value = true
  await router.replace({
    query: {
      path: path.value === '/' ? undefined : path.value,
      page: page.value > 1 ? page.value : undefined,
    },
  })
}
function open(entry?: Entry) {
  editor.value = entry ? 'move' : 'directory'
  original.value = entry?.path ?? ''
  target.value = entry?.path ?? (path.value === '/' ? '/' : path.value + '/')
  message.value = ''
}
async function close() {
  if (busy.value) return
  if (
    target.value !== (original.value || (path.value === '/' ? '/' : path.value + '/')) &&
    !(await feedback.modal('放弃文件操作？', '尚未保存的路径将丢失。'))
  )
    return
  editor.value = undefined
  message.value = ''
}
function save() {
  void run(async () => {
    await api(
      editor.value === 'move' ? '/workspace-files/move' : '/workspace-files/directories',
      editor.value === 'move' ? { path: original.value, to: target.value } : { path: target.value },
    )
    editor.value = undefined
    feedback.toast('文件目录已更新')
    await load()
  })
}
function remove(entry: Entry) {
  void run(async () => {
    if (
      !(await feedback.modal(
        `删除“${entry.path.split('/').at(-1)}”？`,
        '删除后不能恢复。目录必须为空。',
      ))
    )
      return
    await api('/workspace-files/remove', { path: entry.path })
    feedback.toast('已删除')
    await load()
  })
}
function download(entry: Entry) {
  void run(async () => {
    const result = await api<{ url: string }>(
      `/workspace-files/download?path=${encodeURIComponent(entry.path)}`,
    )
    const link = document.createElement('a')
    link.href = result.url
    link.rel = 'noreferrer'
    link.click()
  })
}
function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  if (!file) return
  input.value = ''
  void run(async () => {
    controller = new AbortController()
    uploading.value = true
    percent.value = 0
    try {
      const destination = uploadPath(file.name, path.value)
      await props.files.upload(file, destination, controller.signal, (sent, total) => {
        percent.value = total ? Math.round((sent / total) * 100) : 100
      })
      feedback.toast('文件已上传')
      await load(destination.slice(0, destination.lastIndexOf('/')) || '/', 1)
    } finally {
      uploading.value = false
      percent.value = undefined
      controller = undefined
    }
  })
}
onMounted(() => {
  void run(() => load())
})
const stopGuard = router.beforeEach(async (to, from) => {
  if (to.path === from.path) return true
  if (busy.value) return false
  if (
    editor.value &&
    target.value !== (original.value || (path.value === '/' ? '/' : path.value + '/'))
  )
    return feedback.modal('放弃文件操作？', '尚未保存的路径将丢失。')
  return true
})
onUnmounted(() => {
  controller?.abort()
  stopGuard()
})
</script>
<template>
  <main class="files-ui files-home">
    <header class="files-heading">
      <div>
        <a href="/">返回聊天</a>
        <h1>工作空间文件</h1>
        <p>文件保存在当前工作空间。根目录上传默认归档到当天的上传目录。</p>
      </div>
      <div class="files-actions">
        <button :disabled="busy" title="刷新文件" aria-label="刷新文件" @click="run(() => load())">
          <ArrowPathIcon class="ui-icon" /></button
        ><button :disabled="busy" @click="open()">新建目录</button
        ><button class="primary" :disabled="busy || !loaded" @click="picker?.click()">
          <ArrowUpTrayIcon class="ui-icon" />上传文件</button
        ><input ref="picker" type="file" hidden @change="upload" />
      </div>
    </header>
    <div class="files-summary">
      <span
        >已用 <strong>{{ bytes(used) }}</strong> / {{ bytes(quota) }}</span
      ><span>上传预占 {{ bytes(reserved) }}</span
      ><a href="/admin/storage/">管理配额</a>
    </div>
    <nav class="files-toolbar" aria-label="文件路径">
      <template v-for="(crumb, i) in crumbs" :key="crumb.path"
        ><span v-if="i">/</span
        ><button
          :disabled="busy"
          :aria-current="crumb.path === path ? 'location' : undefined"
          @click="run(() => load(crumb.path, 1))"
        >
          {{ crumb.label }}
        </button></template
      >
    </nav>
    <p v-if="message && !editor" role="alert" class="files-error">
      {{ message }} <button :disabled="busy" @click="run(() => load())">刷新重试</button>
    </p>
    <p v-if="uploading" role="status">
      正在上传 {{ percent }}% <button @click="controller?.abort()">取消上传</button>
    </p>
    <div class="files-panel" :aria-busy="busy">
      <p v-if="!loaded">{{ busy ? '正在加载文件…' : '尚未加载文件，请重试。' }}</p>
      <div v-else class="files-table">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>大小</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in rows" :key="entry.path">
              <td>
                <button
                  v-if="entry.kind === 'directory'"
                  :disabled="busy"
                  class="files-name"
                  @click="run(() => load(entry.path, 1))"
                >
                  <FolderIcon class="ui-icon" />{{ entry.path.split('/').at(-1) }}</button
                ><span v-else class="files-name"
                  ><DocumentIcon class="ui-icon" />{{ entry.path.split('/').at(-1) }}</span
                >
              </td>
              <td>{{ entry.kind === 'directory' ? '目录' : bytes(entry.size) }}</td>
              <td>
                <div class="files-actions">
                  <button v-if="entry.kind === 'file'" :disabled="busy" @click="download(entry)">
                    下载</button
                  ><button :disabled="busy" @click="open(entry)">移动 / 重命名</button
                  ><button :disabled="busy" @click="remove(entry)">删除</button>
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="3">此目录暂无文件。可以上传文件或新建目录。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="files-pagination">
        <span>共 {{ total }} 项</span
        ><PaginationField
          :page="page"
          :total="total"
          :page-size="50"
          :disabled="busy"
          label="文件分页"
          @update:page="run(() => load(path, $event))"
        />
      </div>
    </div>
    <EditorDialog
      v-if="editor"
      :title="editor === 'move' ? '移动 / 重命名' : '新建目录'"
      :busy="busy"
      @close="close"
      ><form id="file-form" novalidate @submit.prevent="save">
        <label for="file-path">完整路径</label
        ><input id="file-path" v-model="target" :disabled="busy" autocomplete="off" />
        <p>以 / 开头，不能使用 . 或 .. 目录；同名路径不会被覆盖。</p>
        <p v-if="message" role="alert" class="files-error">{{ message }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="close">取消</button
        ><button class="primary" form="file-form" :disabled="busy">保存路径</button></template
      ></EditorDialog
    >
  </main>
</template>
