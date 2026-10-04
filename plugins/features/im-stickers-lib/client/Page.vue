<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { EditorDialog } from '@antarestra/webui/components'
import { ArrowPathIcon, PlusIcon, XMarkIcon } from '@antarestra/webui/icons'
import type { Sticker } from '../src/store.js'
import './style.css'

const { api, run, busy, message, router } = useApi()
const feedback = inject(feedbackKey)!
const rows = ref<Sticker[]>([]),
  loaded = ref(false),
  editing = ref(false),
  current = ref<Sticker>()
const query = ref(String(router.currentRoute.value.query.search ?? ''))
const searchInput = ref<HTMLInputElement>(),
  form = ref<HTMLFormElement>()
const draft = reactive({ title: '', description: '', category: '' })
const errors = reactive({ title: '', description: '', category: '', image: '' })
const file = ref<File>(),
  preview = ref(''),
  saved = ref(''),
  imageFailures = reactive(new Set<string>())
const imageVersion = ref(0)
const filtered = computed(() =>
  rows.value.filter((row) =>
    [row.title, row.description, row.category, row.id]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.value.toLocaleLowerCase()),
  ),
)
const dirty = computed(
  () => editing.value && (JSON.stringify(draft) !== saved.value || !!file.value),
)
const imageUrl = (id: string) =>
  `/api/im-stickers/${encodeURIComponent(id)}/content?v=${imageVersion.value}`
function retryImage(id: string) {
  imageFailures.delete(id)
  imageVersion.value++
}
async function load() {
  const data = await api<{ stickers: Sticker[] }>('/im-stickers')
  rows.value = data.stickers
  imageFailures.clear()
  imageVersion.value++
  loaded.value = true
}
function clearFile() {
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = ''
  file.value = undefined
}
function edit(row?: Sticker) {
  current.value = row
  Object.assign(draft, {
    title: row?.title ?? '',
    description: row?.description ?? '',
    category: row?.category ?? '',
  })
  Object.assign(errors, { title: '', description: '', category: '', image: '' })
  clearFile()
  saved.value = JSON.stringify(draft)
  message.value = ''
  editing.value = true
}
async function mayLeave() {
  if (busy.value) return false
  return !dirty.value || (await feedback.modal('放弃表情包修改？', '尚未保存的内容将丢失。'))
}
async function close() {
  if (!(await mayLeave())) return
  editing.value = false
  message.value = ''
  clearFile()
}
function choose(event: Event) {
  clearFile()
  const selected = (event.target as HTMLInputElement).files?.[0]
  errors.image = ''
  if (!selected) return
  if (
    !/^image\/(png|jpeg|gif|webp)$/.test(selected.type) ||
    !selected.size ||
    selected.size > 8 * 1024 ** 2
  ) {
    errors.image = '请选择不超过 8 MiB 的 PNG、JPEG、GIF 或 WebP 图片。'
    ;(event.target as HTMLInputElement).value = ''
    return
  }
  file.value = selected
  preview.value = URL.createObjectURL(selected)
}
function base64(image: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1]!)
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'))
    reader.readAsDataURL(image)
  })
}
async function save() {
  if (busy.value) return
  for (const field of ['title', 'description', 'category'] as const) {
    const max = field === 'description' ? 1000 : 100
    errors[field] =
      /[\x00-\x1f\x7f]/.test(draft[field]) || draft[field].trim().length > max
        ? `最多 ${max} 个字符，不能包含换行。`
        : ''
  }
  if (!draft.title.trim()) errors.title = '请填写表情包标题。'
  errors.image = !current.value && !file.value ? '请选择一张图片。' : ''
  if (Object.values(errors).some(Boolean)) {
    await nextTick()
    form.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    return
  }
  let persisted = false
  await run(async () => {
    if (current.value)
      await api(
        `/im-stickers/${encodeURIComponent(current.value.id)}`,
        { ...draft, revision: current.value.revision },
        'PUT',
      )
    else
      await api('/im-stickers', {
        ...draft,
        data: await base64(file.value!),
        mimeType: file.value!.type,
      })
    persisted = true
    await load()
  })
  if (persisted) {
    editing.value = false
    clearFile()
    feedback.toast(current.value ? '表情包已保存' : '表情包已添加')
  }
}
async function remove(row: Sticker) {
  if (
    !(await feedback.modal(
      `删除表情包「${row.title}」？`,
      '将从全局表情包库删除图片，所有群聊和私聊都将无法继续使用此 ID。此操作无法恢复。',
    ))
  )
    return
  void run(async () => {
    await api(`/im-stickers/${encodeURIComponent(row.id)}/delete`, { revision: row.revision })
    rows.value = rows.value.filter((item) => item.id !== row.id)
    feedback.toast('表情包已删除')
  })
}
function search(clear = false) {
  if (clear) {
    query.value = ''
    searchInput.value?.focus()
  }
  void router.replace({
    query: { ...router.currentRoute.value.query, search: query.value || undefined },
  })
}
const stopGuard = router.beforeEach((to, from) => to.path === from.path || mayLeave())
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
onMounted(() => {
  void run(load)
  window.addEventListener('beforeunload', beforeUnload)
})
onUnmounted(() => {
  stopGuard()
  clearFile()
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
<template>
  <section class="stickers-page">
    <header class="stickers-toolbar">
      <div>
        <p>所有群聊与私聊共用的表情包库。</p>
        <small>图片 ID 可直接用于读取内容和发送图片。</small>
      </div>
      <button :disabled="busy" title="刷新表情包" aria-label="刷新表情包" @click="run(load)">
        <ArrowPathIcon class="ui-icon" />
      </button>
      <button class="primary" :disabled="busy" @click="edit()">
        <PlusIcon class="ui-icon" />添加表情包
      </button>
    </header>
    <form class="stickers-search" novalidate @submit.prevent="search()">
      <label for="sticker-search">查找表情包</label
      ><input
        id="sticker-search"
        ref="searchInput"
        v-model="query"
        placeholder="标题、描述、分类或 ID"
        @change="search()"
      />
      <button
        v-if="query"
        type="button"
        title="清空查询"
        aria-label="清空查询"
        @click="search(true)"
      >
        <XMarkIcon class="ui-icon" />
      </button>
      <span>{{ filtered.length }} / {{ rows.length }} 张</span>
    </form>
    <p v-if="message && !editing" class="stickers-error" role="alert">
      {{ message }} <button :disabled="busy" @click="run(load)">重新加载</button>
    </p>
    <p v-if="!loaded" role="status">{{ busy ? '正在加载表情包…' : '尚未加载，请重试。' }}</p>
    <div v-else-if="!rows.length" class="stickers-empty">
      <h2>添加第一张表情包</h2>
      <p>上传图片，再填写标题、描述和分类。也可由群 bot 管理员使用 /sticker add 添加。</p>
      <button class="primary" :disabled="busy" @click="edit()">添加表情包</button>
    </div>
    <p v-else-if="!filtered.length" role="status">
      没有匹配的表情包。<button @click="search(true)">清空查询</button>
    </p>
    <ul v-else class="stickers-grid" :aria-busy="busy">
      <li v-for="row in filtered" :key="row.id" class="sticker-card">
        <div class="sticker-image">
          <img
            v-if="!imageFailures.has(row.id)"
            :src="imageUrl(row.id)"
            :alt="row.title"
            loading="lazy"
            @error="imageFailures.add(row.id)"
          /><span v-else
            >图片暂时无法加载<button @click="retryImage(row.id)">重试图片</button></span
          >
        </div>
        <div class="sticker-info">
          <span class="sticker-category">{{ row.category }}</span>
          <h2>{{ row.title }}</h2>
          <p>{{ row.description || '暂无文本描述' }}</p>
          <code>{{ row.id }}</code>
        </div>
        <footer>
          <button :disabled="busy" :aria-label="`编辑 ${row.title}`" @click="edit(row)">编辑</button
          ><button
            :disabled="busy"
            :aria-label="`删除 ${row.title}`"
            class="danger"
            @click="remove(row)"
          >
            删除
          </button>
        </footer>
      </li>
    </ul>
    <EditorDialog
      v-if="editing"
      :title="current ? '编辑表情包' : '添加表情包'"
      :busy="busy"
      @close="close"
    >
      <form id="sticker-form" ref="form" class="sticker-form" novalidate @submit.prevent="save">
        <template v-if="!current"
          ><label for="sticker-file">表情包图片</label
          ><input
            id="sticker-file"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            :disabled="busy"
            :aria-invalid="!!errors.image"
            aria-describedby="sticker-file-help sticker-image-error"
            @change="choose"
          /><small id="sticker-file-help">PNG、JPEG、GIF、WebP，最多 8 MiB。</small>
          <p id="sticker-image-error" class="stickers-error">{{ errors.image }}</p></template
        >
        <img
          v-if="preview || current"
          class="sticker-preview"
          :src="preview || imageUrl(current!.id)"
          alt="表情包预览"
        />
        <p v-if="current" class="sticker-id">ID：{{ current.id }}</p>
        <label for="sticker-title">标题</label
        ><input
          id="sticker-title"
          v-model="draft.title"
          maxlength="100"
          :disabled="busy"
          :aria-invalid="!!errors.title"
          aria-describedby="sticker-title-error"
        />
        <p id="sticker-title-error" class="stickers-error">{{ errors.title }}</p>
        <label for="sticker-description">文本描述</label
        ><textarea
          id="sticker-description"
          v-model="draft.description"
          rows="3"
          maxlength="1000"
          style="resize: none"
          :disabled="busy"
          :aria-invalid="!!errors.description"
          aria-describedby="sticker-description-error"
        />
        <p id="sticker-description-error" class="stickers-error">{{ errors.description }}</p>
        <label for="sticker-category">分类</label
        ><input
          id="sticker-category"
          v-model="draft.category"
          maxlength="100"
          placeholder="未分类"
          :disabled="busy"
          :aria-invalid="!!errors.category"
          aria-describedby="sticker-category-error"
        />
        <p id="sticker-category-error" class="stickers-error">{{ errors.category }}</p>
        <p v-if="message" role="alert" class="stickers-error">{{ message }}</p>
        <p v-if="busy" role="status">{{ current ? '正在保存修改…' : '正在上传并保存表情包…' }}</p>
      </form>
      <template #footer
        ><button :disabled="busy" @click="close">取消</button
        ><button class="primary" form="sticker-form" :disabled="busy">
          {{ current ? '保存修改' : '添加表情包' }}
        </button></template
      >
    </EditorDialog>
  </section>
</template>
