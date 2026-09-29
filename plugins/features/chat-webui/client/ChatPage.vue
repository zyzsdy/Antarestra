<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Conversation, MessageNode } from '@antarestra/contracts'
import { feedbackKey } from '@antarestra/webui/client'
import {
  AntarestraLogo,
  DialogRoot,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  DialogClose,
  VisuallyHidden,
  EditorDialog,
  SelectField,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
  SliderRoot,
  SliderTrack,
  SliderRange,
  SliderThumb,
} from '@antarestra/webui/components'
import {
  PlusIcon,
  Bars3Icon,
  ArrowUpIcon,
  StopIcon,
  ChevronDownIcon,
  PaperClipIcon,
  XMarkIcon,
} from '@antarestra/webui/icons'
import type { Session } from './session.js'
import type { WorkspaceFilesClient } from '@antarestra/plugin-workspace-file/client'
import { uploadPath } from '@antarestra/plugin-workspace-file/client'
import ChatHistory from './ChatHistory.vue'
import ChatMessage from './ChatMessage.vue'
import { useChat } from './useChat.js'

const props = defineProps<{
  session: Session | undefined
  failure: string
  signal: AbortSignal
  canAdmin: boolean
  logout: () => Promise<void>
  files: WorkspaceFilesClient | undefined
}>()
const feedback = inject(feedbackKey)!
const filePicker = ref<HTMLInputElement>()
const fileBusy = ref(false)
const fileError = ref('')
let fileController: AbortController | undefined
async function uploadFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.files || fileBusy.value) return
  input.value = ''
  fileBusy.value = true
  fileError.value = ''
  fileController = new AbortController()
  const conversationId = currentId.value
  try {
    const path = uploadPath(file.name)
    const saved = await props.files.upload(file, path, fileController.signal)
    if (currentId.value === conversationId)
      draft.value += `${draft.value ? '\n' : ''}工作空间文件：${saved.path}`
    feedback.toast('文件已保存到工作空间；Agent 可通过文件工具读取文本')
  } catch (error) {
    fileError.value = error instanceof Error ? error.message : '上传失败'
  } finally {
    fileBusy.value = false
    fileController = undefined
  }
}
onUnmounted(() => fileController?.abort())
const {
  catalog,
  conversations,
  archived,
  more,
  listing,
  loading,
  sending,
  stopping,
  error,
  listError,
  detail,
  runs,
  draft,
  agentId,
  agent,
  selectedModel,
  modelOptions,
  thinking,
  levels,
  activeRunId,
  lastRun,
  interrupted,
  unavailable,
  reply,
  replies,
  disconnected,
  currentId,
  pending,
  list,
  load,
  navigate,
  initialize,
  send,
  branches,
  selectBranch,
  stop,
  continuePrevious,
  update,
} = useChat(() => props.session)
const sidebar = ref(false)
const narrow = ref(false)
const media = matchMedia('(max-width: 760px)')
const input = ref<HTMLTextAreaElement>()
const messages = ref<HTMLElement>()
const following = ref(true)
const rename = ref<Conversation>()
const title = ref('')
const renameError = ref('')
const saving = ref(false)
const editing = ref<MessageNode>()
const editInput = ref<HTMLTextAreaElement>()
const editText = ref('')
const editError = ref('')
const actionsDisabled = computed(
  () =>
    loading.value ||
    !detail.value ||
    sending.value ||
    !!activeRunId.value ||
    archivedConversation.value ||
    !!unavailable.value ||
    pending.has(currentId.value),
)
function editMessage(node: MessageNode) {
  editing.value = node
  editText.value = node.input?.text ?? ''
  editError.value = ''
}
async function saveMessage() {
  const node = editing.value
  if (!node || actionsDisabled.value) return
  if (!editText.value.trim()) {
    editError.value = '请输入消息内容'
    editInput.value?.focus()
    return
  }
  const result = await send(false, node, editText.value)
  if (result && editing.value === node) editing.value = undefined
  else editError.value = error.value || '发送未完成，请关闭编辑窗口后核对并重试发送。'
}
async function regenerate(node: MessageNode) {
  await send(true, node)
}
async function closeMessageEditor() {
  if (sending.value) return
  if (
    !pending.has(currentId.value) &&
    editText.value !== (editing.value?.input?.text ?? '') &&
    !(await feedback.modal('放弃修改', '消息修改尚未发送，确定放弃吗？'))
  )
    return
  editing.value = undefined
}
const archivedConversation = computed(() => detail.value?.conversation.archivedAt != null)
function thinkingLabel(level: string | null | undefined) {
  const labels: Record<string, string> = {
    off: '关闭',
    minimal: '最低',
    low: '轻度',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大',
  }
  return level ? (labels[level] ?? level) : ''
}
const intensity = computed({
  get: () => [Math.max(0, levels.value.indexOf(thinking.value ?? ''))],
  set: (value: number[] | undefined) => {
    thinking.value = levels.value[value?.[0] ?? 0] ?? null
  },
})
const canSend = computed(
  () =>
    !loading.value &&
    (!currentId.value || !!detail.value) &&
    !sending.value &&
    !fileBusy.value &&
    !activeRunId.value &&
    !archivedConversation.value &&
    !unavailable.value &&
    (!!pending.get(currentId.value) || (!interrupted.value && !!draft.value.trim())),
)
function resize() {
  narrow.value = media.matches
  if (!narrow.value) sidebar.value = false
  grow()
}
function grow() {
  if (!input.value) return
  input.value.style.height = '0px'
  const max = Math.max(48, Math.min(16 * 24, window.innerHeight * 0.45))
  input.value.style.height = `${Math.min(max, Math.max(48, input.value.scrollHeight))}px`
}
function scroll() {
  if (messages.value)
    following.value =
      messages.value.scrollHeight - messages.value.scrollTop - messages.value.clientHeight < 100
}
function bottom() {
  if (messages.value) messages.value.scrollTop = messages.value.scrollHeight
  following.value = true
}
watch(draft, () => {
  void nextTick(grow)
})
watch(
  () => [reply.value.sequence, detail.value?.path],
  async () => {
    await nextTick()
    if (following.value) bottom()
  },
)
watch(currentId, () => {
  editing.value = undefined
  following.value = true
  sidebar.value = false
})
async function select(id = '') {
  sidebar.value = false
  await navigate(id)
  await nextTick()
  input.value?.focus()
}
async function submit() {
  if (!canSend.value) return
  following.value = true
  await send()
  await nextTick()
  grow()
  input.value?.focus()
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    void submit()
  }
}
function edit(item: Conversation) {
  rename.value = item
  title.value = item.title
  renameError.value = ''
}
async function saveTitle() {
  if (!rename.value || saving.value) return
  if (!title.value.trim() || title.value.trim().length > 200) {
    renameError.value = '请输入 1–200 个字符的标题'
    return
  }
  saving.value = true
  try {
    await update(rename.value.id, { title: title.value.trim() })
    rename.value = undefined
  } catch (cause) {
    renameError.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    saving.value = false
  }
}
async function archive(item: Conversation) {
  try {
    await update(item.id, { archived: item.archivedAt === null })
    feedback.toast(item.archivedAt === null ? '对话已归档，可在归档列表中恢复。' : '已取消归档')
  } catch (cause) {
    feedback.toast(cause instanceof Error ? cause.message : '归档操作失败')
  }
}
async function retry() {
  if (await feedback.modal('重试本轮对话', '将重新执行本轮请求，工具可能再次执行。'))
    await send(true)
}
async function check() {
  try {
    const response = await fetch('/api/chat-webui/session', {
      cache: 'no-store',
      signal: props.signal,
    })
    if (!response.ok) {
      location.reload()
      return
    }
    const fresh = (await response.json()) as Session
    if (
      fresh.actorId !== props.session?.actorId ||
      fresh.workspaceId !== props.session?.workspaceId
    )
      location.reload()
    else {
      void list()
    }
  } catch {
    /* 暂时离线时保留草稿，下一次聚焦重试。 */
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (draft.value || (editing.value && editText.value !== editing.value.input?.text)) {
    event.preventDefault()
    event.returnValue = ''
  }
}
resize()
onMounted(() => {
  media.addEventListener('change', resize)
  window.addEventListener('resize', grow)
  window.addEventListener('focus', check)
  window.addEventListener('beforeunload', beforeUnload)
})
onUnmounted(() => {
  media.removeEventListener('change', resize)
  window.removeEventListener('resize', grow)
  window.removeEventListener('focus', check)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main v-if="!session" class="chat-error" role="alert">
    <h1>暂时无法进入聊天</h1>
    <p>{{ failure }}</p>
    <a href="/">重试</a>
  </main>
  <DialogRoot v-else v-model:open="sidebar">
    <div class="chat-app">
      <DialogOverlay v-if="narrow" class="chat-backdrop" />
      <component
        :is="narrow ? DialogContent : 'aside'"
        class="chat-sidebar"
        :aria-describedby="undefined"
        aria-label="聊天记录"
      >
        <VisuallyHidden v-if="narrow"><DialogTitle>聊天记录</DialogTitle></VisuallyHidden>
        <DialogClose
          v-if="narrow"
          class="chat-icon-button chat-drawer-close"
          aria-label="关闭聊天记录"
          ><XMarkIcon class="ui-icon"
        /></DialogClose>
        <ChatHistory
          :session="session"
          :can-admin="canAdmin"
          :logout="logout"
          :items="conversations"
          :current-id="currentId"
          :archived="archived"
          :loading="listing"
          :more="more"
          :error="listError"
          @new="select()"
          @select="select"
          @toggle="(value) => (archived = value)"
          @more="list(true)"
          @refresh="list()"
          @rename="edit"
          @archive="archive"
        />
      </component>
      <main class="chat-main">
        <header class="chat-header">
          <DialogTrigger v-if="narrow" class="chat-icon-button" aria-label="打开聊天记录"
            ><Bars3Icon class="ui-icon"
          /></DialogTrigger>
          <SelectField
            v-if="!currentId"
            v-model="agentId"
            class="chat-agent"
            :options="catalog.agents.map((item) => ({ id: item.id, name: item.title }))"
            label="选择 Agent"
            compact
            :disabled="sending"
            placeholder="选择 Agent"
          />
          <span v-else class="chat-agent-name">{{
            agent?.title || detail?.conversation.agentId || '对话'
          }}</span>
          <span v-if="activeRunId" class="chat-header-status">正在生成</span>
        </header>
        <div class="chat-message-area" :aria-busy="loading">
          <section
            ref="messages"
            class="chat-messages"
            aria-label="消息记录"
            :inert="loading || (!!currentId && !detail)"
            @scroll="scroll"
          >
            <div v-if="!detail?.path.length && !loading" class="chat-welcome">
              <AntarestraLogo :size="60" decorative />
              <h1>今天，有什么新想法？</h1>
              <p>从一次对话开始。</p>
            </div>
            <div v-if="detail?.path.length" class="chat-transcript">
              <ChatMessage
                v-for="node in detail.path"
                :key="node.id"
                :node="node"
                :run="runs.get(node.runId)"
                :live="node.role === 'assistant' ? replies.get(node.runId) : undefined"
                :disabled="actionsDisabled"
                :branches="node.role === 'assistant' ? branches(node) : []"
                @edit="editMessage(node)"
                @regenerate="regenerate(node)"
                @branch="selectBranch"
              />
            </div>
          </section>
          <div v-if="loading" class="chat-loading" role="status"><span>正在加载对话…</span></div>
        </div>
        <footer class="chat-composer-area">
          <p v-if="fileError" class="chat-inline-error" role="alert">{{ fileError }}</p>
          <p v-if="fileBusy" class="chat-inline-error" role="status">
            正在上传文件… <button type="button" @click="fileController?.abort()">取消上传</button>
          </p>
          <div v-if="!following" class="chat-bottom-link">
            <button class="chat-text-button" @click="bottom">回到底部 ↓</button>
          </div>
          <p v-if="error" class="chat-inline-error" role="alert">
            {{ error }}
            <button
              class="chat-text-button"
              :disabled="sending"
              @click="pending.has(currentId) ? send() : initialize()"
            >
              {{ pending.has(currentId) ? '核对并重试发送' : '重新加载' }}
            </button>
          </p>
          <p v-if="disconnected" class="chat-inline-error" role="status">
            连接已断开，生成可能仍在继续。<button class="chat-text-button" @click="load">
              重新连接
            </button>
          </p>
          <p v-if="archivedConversation" class="chat-inline-notice">
            此对话已归档。<button
              class="chat-text-button"
              @click="detail && archive(detail.conversation)"
            >
              取消归档并继续
            </button>
          </p>
          <div v-else-if="interrupted" class="chat-recovery" role="status">
            <span>{{ lastRun?.status === 'cancelled' ? '本轮生成已停止。' : '本轮未完成。' }}</span
            ><button class="chat-text-button" :disabled="sending || !!unavailable" @click="retry">
              重试本轮</button
            ><button class="chat-text-button" :disabled="sending" @click="continuePrevious">
              从上一完整轮次继续
            </button>
          </div>
          <p v-if="unavailable && !loading" class="chat-muted" role="status">{{ unavailable }}</p>
          <form class="chat-composer" novalidate @submit.prevent="submit">
            <textarea
              ref="input"
              v-model="draft"
              rows="2"
              style="resize: none"
              aria-label="消息输入框"
              :disabled="archivedConversation"
              placeholder="随意问些什么"
              @keydown="keydown"
            />
            <div class="chat-composer-toolbar">
              <input ref="filePicker" type="file" hidden @change="uploadFile" />
              <DropdownMenuRoot
                ><DropdownMenuTrigger class="chat-icon-button" type="button" aria-label="添加内容"
                  ><PlusIcon class="ui-icon" /></DropdownMenuTrigger
                ><DropdownMenuPortal
                  ><DropdownMenuContent
                    class="chat-popover"
                    side="top"
                    :side-offset="8"
                    :collision-padding="12"
                    ><DropdownMenuItem
                      class="chat-menu-item"
                      :disabled="!files || fileBusy"
                      @select="filePicker?.click()"
                      ><PaperClipIcon class="ui-icon" />上传工作空间文件</DropdownMenuItem
                    ><DropdownMenuItem v-if="files" class="chat-menu-item" as-child
                      ><a href="/files/">管理工作空间文件</a></DropdownMenuItem
                    ><small class="chat-menu-note"
                      >文本可由 Agent 文件工具读取</small
                    ></DropdownMenuContent
                  ></DropdownMenuPortal
                ></DropdownMenuRoot
              >
              <div class="chat-model-controls">
                <SelectField
                  v-model="selectedModel"
                  :options="modelOptions"
                  label="选择模型"
                  compact
                  :disabled="!!activeRunId || sending || archivedConversation"
                  placeholder="选择模型"
                />
                <PopoverRoot v-if="levels.length > 1"
                  ><PopoverTrigger
                    class="chat-thinking-button"
                    type="button"
                    :disabled="!!activeRunId || sending || archivedConversation"
                    aria-label="选择推理强度"
                    >{{ thinkingLabel(thinking)
                    }}<ChevronDownIcon class="ui-icon" /></PopoverTrigger
                  ><PopoverPortal
                    ><PopoverContent
                      class="chat-popover chat-thinking-popover"
                      side="top"
                      :side-offset="12"
                      :collision-padding="12"
                      ><p>推理强度：{{ thinkingLabel(thinking) }}</p>
                      <SliderRoot
                        v-model="intensity"
                        class="chat-slider"
                        :style="{
                          '--chat-slider-progress':
                            (intensity[0] ?? 0) / Math.max(1, levels.length - 1),
                        }"
                        :min="0"
                        :max="levels.length - 1"
                        :step="1"
                        ><SliderTrack class="chat-slider-track"
                          ><SliderRange class="chat-slider-range" />
                          <span class="chat-slider-marks" aria-hidden="true">
                            <span
                              v-for="level in levels"
                              :key="level"
                              class="chat-slider-mark"
                            /> </span></SliderTrack
                        ><SliderThumb
                          class="chat-slider-thumb"
                          aria-label="推理强度"
                          :aria-valuetext="thinkingLabel(thinking)"
                      /></SliderRoot>
                      <div class="chat-slider-labels">
                        <span>{{ thinkingLabel(levels[0]) }}</span
                        ><span>{{ thinkingLabel(levels.at(-1)) }}</span>
                      </div></PopoverContent
                    ></PopoverPortal
                  ></PopoverRoot
                >
                <span v-else-if="levels.length === 1" class="chat-thinking-single">{{
                  thinkingLabel(thinking)
                }}</span>
                <button
                  v-if="activeRunId"
                  type="button"
                  class="chat-send"
                  :disabled="stopping"
                  :aria-label="stopping ? '正在停止生成' : '停止生成'"
                  @click="stop"
                >
                  <StopIcon class="ui-icon" />
                </button>
                <button
                  v-else
                  type="submit"
                  class="chat-send"
                  :disabled="!canSend"
                  :aria-label="sending ? '正在发送' : '发送消息'"
                >
                  <ArrowUpIcon class="ui-icon" />
                </button>
              </div>
            </div>
          </form>
          <p class="chat-hint">Enter 发送 · Shift+Enter 换行</p>
        </footer>
      </main>
      <EditorDialog v-if="editing" title="编辑消息" :busy="sending" @close="closeMessageEditor">
        <form class="chat-rename-form" novalidate @submit.prevent="saveMessage">
          <label for="chat-edit-message">消息内容</label>
          <textarea
            ref="editInput"
            id="chat-edit-message"
            v-model="editText"
            :disabled="sending || pending.has(currentId)"
            rows="8"
            style="resize: none"
            :aria-invalid="!!editError"
            aria-describedby="chat-edit-error"
          />
          <p class="chat-inline-notice">发送后创建新分支，原消息和回复仍会保留。</p>
          <p id="chat-edit-error" class="chat-inline-error" role="alert">{{ editError }}</p>
          <p v-if="pending.has(currentId)" class="chat-inline-notice">
            请求结果尚未确认。请关闭编辑窗口，使用消息输入区的“核对并重试发送”继续，原请求会保留。
          </p>
          <button class="chat-save" :disabled="actionsDisabled">
            {{ sending ? '正在发送…' : '保存并发送' }}
          </button>
        </form>
      </EditorDialog>
      <EditorDialog v-if="rename" title="重命名对话" :busy="saving" @close="rename = undefined"
        ><form class="chat-rename-form" novalidate @submit.prevent="saveTitle">
          <label for="chat-title">对话标题</label
          ><input
            id="chat-title"
            v-model="title"
            maxlength="200"
            :aria-invalid="!!renameError"
            aria-describedby="chat-title-error"
          />
          <p id="chat-title-error" class="chat-inline-error" role="alert">{{ renameError }}</p>
          <button class="chat-save" :disabled="saving">{{ saving ? '正在保存…' : '保存' }}</button>
        </form></EditorDialog
      >
    </div>
  </DialogRoot>
</template>

<style src="./chat.css"></style>
