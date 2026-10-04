<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'
import {
  EditorDialog,
  PaginationField,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@antarestra/webui/components'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import type { ArchivedMessage, AiHistoryEntry, AiHistoryDetail } from '@antarestra/im'
import AiHistoryDetailView from './AiHistoryDetail.vue'
import { formatTime, jobStates, deliveryStates, segmentText } from './history-format'

const props = defineProps<{ workspaceId: string; name: string }>()
const { api, run, busy, message } = useApi()
const base = `/im/groups/${encodeURIComponent(props.workspaceId)}`
const tab = ref('messages')
const messages = ref<ArchivedMessage[]>([])
const messagesLoaded = ref(false)
const nextBefore = ref<number | null>(null)
const keyword = ref('')
const appliedKeyword = ref('')
const entries = ref<AiHistoryEntry[]>([])
const aiLoaded = ref(false)
const available = ref(true)
const total = ref(0)
const page = ref(1)
const conversation = ref<string | null>(null)
const detail = ref<AiHistoryDetail>()
const dialog = ref(false)
let detailTrigger: HTMLElement | null = null
let retry = refresh
function perform(action: () => Promise<void>) {
  retry = action
  void run(action)
}
async function loadMessages(older = false) {
  const query = new URLSearchParams({ keyword: appliedKeyword.value })
  if (older && nextBefore.value !== null) query.set('before', String(nextBefore.value))
  const result = await api<{ messages: ArchivedMessage[]; nextBefore: number | null }>(
    `${base}/messages?${query}`,
  )
  messages.value = older
    ? [...messages.value, ...result.messages.reverse()]
    : result.messages.reverse()
  nextBefore.value = result.nextBefore
  messagesLoaded.value = true
}
async function search(clear = false) {
  if (clear) keyword.value = ''
  const previous = appliedKeyword.value
  appliedKeyword.value = keyword.value.trim()
  try {
    await loadMessages()
  } catch (error) {
    appliedKeyword.value = previous
    throw error
  }
}
async function loadAi(nextPage = page.value) {
  const result = await api<{
    available: boolean
    entries: AiHistoryEntry[]
    total: number
    currentConversationId: string | null
  }>(`${base}/ai?offset=${(nextPage - 1) * 20}`)
  entries.value = result.entries
  total.value = result.total
  conversation.value = result.currentConversationId
  available.value = result.available
  page.value = nextPage
  aiLoaded.value = true
}
async function showDetail(id: string, target: EventTarget | null) {
  detailTrigger = target instanceof HTMLElement ? target : null
  detail.value = await api<AiHistoryDetail>(`${base}/ai/${encodeURIComponent(id)}`)
  dialog.value = true
}
async function closeDetail() {
  dialog.value = false
  await nextTick()
  requestAnimationFrame(() => {
    if (detailTrigger?.isConnected) detailTrigger.focus()
  })
}
function switchTab(value: string | number) {
  tab.value = String(value)
  message.value = ''
  if (tab.value === 'ai' && !aiLoaded.value) perform(() => loadAi())
}
function refresh() {
  return tab.value === 'ai' ? loadAi() : loadMessages()
}
onMounted(() => {
  perform(() => loadMessages())
})
</script>

<template>
  <section class="im-panel im-history" :aria-busy="busy">
    <div class="im-toolbar">
      <h2>{{ name }}</h2>
      <button
        :disabled="busy"
        title="刷新当前记录"
        aria-label="刷新当前记录"
        @click="perform(refresh)"
      >
        <ArrowPathIcon class="ui-icon" />
      </button>
    </div>
    <p class="im-hint">时间按浏览器本地时区显示。消息按新到旧排列；刷新可查看最新处理进度。</p>
    <p v-if="message" class="im-error" role="alert">
      {{ message }}<button :disabled="busy" @click="perform(retry)">重试</button>
    </p>
    <p v-if="busy" role="status">正在读取记录…</p>
    <TabsRoot :model-value="tab" @update:model-value="switchTab">
      <TabsList class="im-history-tabs" aria-label="群记录类型"
        ><TabsTrigger value="messages" :disabled="busy">消息历史</TabsTrigger
        ><TabsTrigger value="ai" :disabled="busy">AI 会话</TabsTrigger></TabsList
      >
      <TabsContent value="messages">
        <form class="im-toolbar" novalidate @submit.prevent="perform(() => search())">
          <label for="im-message-keyword">消息关键词</label
          ><input
            id="im-message-keyword"
            v-model="keyword"
            maxlength="200"
            :disabled="busy"
            placeholder="在该群的归档消息中搜索"
          /><button type="submit" :disabled="busy">查询</button
          ><button
            v-if="keyword || appliedKeyword"
            type="button"
            :disabled="busy"
            @click="perform(() => search(true))"
          >
            清空筛选
          </button>
        </form>
        <p v-if="messagesLoaded && !messages.length" class="im-hint" role="status">
          {{ appliedKeyword ? '没有匹配的消息，请调整关键词。' : '该群暂无归档消息。' }}
        </p>
        <p v-else-if="!messagesLoaded && !busy" role="status">消息尚未加载，请刷新重试。</p>
        <p v-if="appliedKeyword" class="im-hint">当前结果：{{ appliedKeyword }}</p>
        <ol class="im-message-list">
          <li v-for="item in messages" :key="item.id" class="im-message-item">
            <div class="im-message-meta">
              <strong>{{ item.message.sender.name || item.message.sender.id }}</strong
              ><span>{{ item.message.sender.id }}</span
              ><span v-if="item.message.sender.bot">机器人</span
              ><time>{{ formatTime(item.message.timestamp ?? item.receivedAt) }}</time>
            </div>
            <p class="im-history-text">{{ item.message.segments.map(segmentText).join('') }}</p>
            <p v-if="item.media.length" class="im-hint">
              媒体归档：{{
                item.media
                  .map(
                    (media) =>
                      `${media.resource?.filename || '附件'} · ${{ pending: '保存中', stored: '已保存', failed: '保存失败', expired: '已过期' }[media.status]}`,
                  )
                  .join('；')
              }}
            </p>
            <small class="im-hint">消息 ID：{{ item.message.id }}</small>
          </li>
        </ol>
        <button
          v-if="nextBefore !== null"
          :disabled="busy"
          @click="perform(() => loadMessages(true))"
        >
          加载更早消息
        </button>
      </TabsContent>
      <TabsContent value="ai">
        <p v-if="!aiLoaded" role="status">
          {{ busy ? '正在读取 AI 会话…' : 'AI 会话尚未加载，请刷新重试。' }}
        </p>
        <p v-else-if="!available" class="im-hint" role="status">
          IM AI 历史服务未启用。请启用 IM AI 插件后刷新；群消息历史仍可查看。
        </p>
        <template v-else>
          <p class="im-hint im-history-id">
            当前会话：{{ conversation || '暂无；下次 AI 激活时建立' }}
          </p>
          <p class="im-hint">
            共 {{ total }} 次处理，包含重置前的历史会话。处理成功与回复投递分开显示。
          </p>
          <p v-if="!entries.length" role="status">该群暂无 AI 处理记录。</p>
          <div v-else class="im-table">
            <table>
              <thead>
                <tr>
                  <th>发起时间 / 会话</th>
                  <th>IM 输入摘要</th>
                  <th>处理与投递</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="entry in entries" :key="entry.id">
                  <td>
                    {{ formatTime(entry.createdAt)
                    }}<small>{{ entry.conversationId || '尚未建立会话' }}</small
                    ><small v-if="entry.conversationId && entry.conversationId === conversation"
                      >当前会话</small
                    >
                  </td>
                  <td class="im-input-preview">
                    {{ entry.inputPreview }}
                  </td>
                  <td>
                    {{ jobStates[entry.status]
                    }}<small>{{
                      entry.hasAnswer ? deliveryStates[entry.delivery] : '无待投递回复'
                    }}</small>
                  </td>
                  <td>
                    <button
                      :disabled="busy"
                      @click="perform(() => showDetail(entry.id, $event.currentTarget))"
                    >
                      查看输入与返回
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <PaginationField
            v-if="total > 20"
            :page="page"
            :total="total"
            :page-size="20"
            :disabled="busy"
            label="AI 处理记录分页"
            @update:page="perform(() => loadAi($event))"
          />
        </template>
      </TabsContent>
    </TabsRoot>
    <EditorDialog
      v-if="dialog && detail"
      title="AI 输入与返回"
      class="im-editor im-history-dialog"
      @close="closeDetail"
    >
      <AiHistoryDetailView :detail="detail" />
      <template #footer><button @click="closeDetail">关闭</button></template>
    </EditorDialog>
  </section>
</template>
