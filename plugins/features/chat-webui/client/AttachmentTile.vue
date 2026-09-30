<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ContentBlock } from '@antarestra/contracts'
import { EditorDialog } from '@antarestra/webui/components'
import { DocumentIcon, XMarkIcon, ArrowDownTrayIcon } from '@antarestra/webui/icons'
const props = defineProps<{
  attachment: Extract<ContentBlock, { resourceId: string }>
  removable?: boolean
  busy?: boolean
  status?: string
  preview?: string
  draft?: boolean
}>()
defineEmits<{ remove: [] }>()
const opened = ref(false)
const expired = ref(false)
const failure = ref('')
const loading = ref(false)
const imageFailed = ref(false)
const name = computed(() => props.attachment.filename || props.attachment.resourceId)
const base = computed(
  () => `/api/workspace-files/resources/${encodeURIComponent(props.attachment.resourceId)}`,
)
const image = computed(
  () => props.attachment.type === 'image' && !imageFailed.value && !expired.value,
)
let controller: AbortController | undefined
async function inspect() {
  controller?.abort()
  const local = new AbortController()
  controller = local
  loading.value = true
  failure.value = ''
  try {
    const response = await fetch(base.value, {
      signal: local.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (local.signal.aborted) return
    expired.value = [404, 410].includes(response.status)
    if (!response.ok && !expired.value) throw new Error('暂时无法访问附件，请重试')
  } catch (error) {
    if (!local.signal.aborted)
      failure.value = error instanceof Error ? error.message : '附件访问失败'
  } finally {
    if (!local.signal.aborted) loading.value = false
  }
}
watch(
  () => props.attachment.resourceId,
  () => {
    expired.value = false
    imageFailed.value = false
    if (!props.draft) void inspect()
  },
  { immediate: true },
)
async function open() {
  opened.value = true
  if (!props.status) await inspect()
}
function imageError() {
  imageFailed.value = true
  if (!props.status) void inspect()
}
onUnmounted(() => controller?.abort())
</script>

<template>
  <div class="chat-attachment" :class="{ 'chat-attachment-image': image }">
    <button
      type="button"
      class="chat-attachment-open"
      :disabled="busy || !!status"
      :aria-label="`查看附件：${name}`"
      @click="open"
    >
      <img v-if="image" :src="preview || `${base}/content`" :alt="name" @error="imageError" />
      <template v-else
        ><DocumentIcon class="ui-icon" /><span class="chat-attachment-name"
          >{{ name }}<small v-if="expired">文件已过期</small></span
        ></template
      >
      <span v-if="status" class="chat-attachment-status" role="status">{{ status }}</span>
    </button>
    <button
      v-if="removable"
      type="button"
      class="chat-attachment-remove"
      :disabled="busy"
      :aria-label="`删除附件：${name}`"
      :title="`删除附件：${name}`"
      @click="$emit('remove')"
    >
      <XMarkIcon class="ui-icon" />
    </button>
  </div>
  <EditorDialog v-if="opened" :title="name" @close="opened = false">
    <div class="chat-attachment-detail">
      <p v-if="loading" role="status">正在检查文件…</p>
      <p v-else-if="expired" role="status">文件已过期</p>
      <p v-else-if="failure" role="alert">
        {{ failure }} <button type="button" class="chat-text-button" @click="inspect">重试</button>
      </p>
      <template v-else>
        <img v-if="image" :src="`${base}/content`" :alt="name" @error="imageError" />
        <DocumentIcon v-else class="chat-file-detail-icon ui-icon" />
        <p>
          {{ attachment.mimeType
          }}<span v-if="attachment.size !== undefined">
            · {{ (attachment.size / 1024).toFixed(1) }} KiB</span
          >
        </p>
        <a class="chat-save chat-download" :href="`${base}/content?download=1`"
          ><ArrowDownTrayIcon class="ui-icon" />下载文件</a
        >
      </template>
    </div>
  </EditorDialog>
</template>
