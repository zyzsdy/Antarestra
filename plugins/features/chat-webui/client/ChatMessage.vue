<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { MarkdownView } from '@antarestra/plugin-markdown-render/client'
import type { ContentBlock, MessageNode, RunRecord } from '@antarestra/contracts'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
  TooltipProvider,
  CopyIcon,
} from '@antarestra/webui/components'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilSquareIcon,
  ArrowPathIcon,
} from '@antarestra/webui/icons'
import MessageAction from './MessageAction.vue'
import AttachmentTile from './AttachmentTile.vue'
import { formatMessageTime } from './message-time.js'
import type { ReplyState } from './stream.js'
import { historyToolDetails } from './tool-details.js'
import { replyContent } from './reply-content.js'
const props = defineProps<{
  node: MessageNode
  run?: RunRecord | undefined
  live?: ReplyState | undefined
  disabled?: boolean
  branches?: MessageNode[]
}>()
defineEmits<{ edit: []; regenerate: []; branch: [id: string] }>()
const feedback = inject(feedbackKey)!
const now = ref(new Date())
const copying = ref(false)
const branchIndex = computed(
  () => props.branches?.findIndex((node) => node.id === props.node.id) ?? -1,
)
async function copy() {
  if (copying.value) return
  copying.value = true
  try {
    await navigator.clipboard.writeText(body.value)
    feedback.toast('已复制消息')
  } catch {
    feedback.toast('复制失败，请检查浏览器剪贴板权限后重试')
  } finally {
    copying.value = false
  }
}
const content = computed(() =>
  props.live ? [...props.live.completed, ...props.live.pending] : props.node.content,
)
const text = (blocks: ContentBlock[], kind: 'text' | 'thinking') =>
  blocks.flatMap((block) => (block.type === kind && 'text' in block ? [block.text] : [])).join('')
const body = computed(() =>
  props.node.role === 'user'
    ? (props.node.input?.text ?? text(content.value, 'text'))
    : presentation.value.body,
)
const presentation = computed(() => replyContent(content.value, tools.value))
const detailsOpen = ref(!!props.live && !props.live.ended)
watch(
  () => !!props.live && !props.live.ended,
  (running) => {
    detailsOpen.value = running
  },
)
const attachments = computed(() =>
  content.value.filter(
    (block): block is Extract<ContentBlock, { resourceId: string }> =>
      block.type === 'image' || block.type === 'file',
  ),
)
const tools = computed(() => (props.live ? props.live.tools : historyToolDetails(props.run)))
</script>

<template>
  <article
    class="chat-message"
    :class="node.role"
    :aria-label="node.role === 'user' ? '你的消息' : '助理回复'"
    @mouseenter="now = new Date()"
    @focusin="now = new Date()"
  >
    <CollapsibleRoot
      v-if="node.role === 'assistant' && presentation.details.length"
      v-model:open="detailsOpen"
      class="chat-details"
    >
      <CollapsibleTrigger class="chat-detail-trigger"
        ><ChevronDownIcon class="ui-icon" />思考与工具详情</CollapsibleTrigger
      >
      <CollapsibleContent>
        <template v-for="detail in presentation.details" :key="detail.id">
          <MarkdownView
            v-if="detail.type !== 'tool'"
            :source="detail.text"
            :streaming="!!live && !live.ended"
          />
          <CollapsibleRoot v-else class="chat-tool">
            <CollapsibleTrigger class="chat-detail-trigger chat-tool-trigger">
              <ChevronDownIcon class="ui-icon" />
              <span class="chat-tool-name">已调用 {{ detail.tool.name }}</span>
              <span class="chat-tool-status" :class="{ 'chat-run-error': detail.tool.isError }">{{
                detail.tool.status
              }}</span>
            </CollapsibleTrigger>
            <CollapsibleContent class="chat-tool-content">
              <p class="chat-tool-label">调用参数</p>
              <pre>{{ JSON.stringify(detail.tool.arguments, null, 2) }}</pre>
              <p class="chat-tool-label">返回结果</p>
              <img
                v-if="detail.tool.image"
                :src="detail.tool.image"
                alt="提供商生成的图片"
                class="chat-generated-image"
              />
              <pre
                v-if="detail.tool.result !== undefined"
                :class="{ 'chat-run-error': detail.tool.isError }"
                >{{ JSON.stringify(detail.tool.result, null, 2) }}</pre>
              <p v-else class="chat-tool-empty">
                {{
                  (live && !live.ended) || run?.status === 'running'
                    ? '等待工具返回…'
                    : '工具未返回结果'
                }}
              </p>
            </CollapsibleContent>
          </CollapsibleRoot>
        </template>
      </CollapsibleContent>
    </CollapsibleRoot>
    <div v-if="attachments.length" class="chat-attachments chat-message-attachments">
      <AttachmentTile
        v-for="attachment in attachments"
        :key="attachment.resourceId"
        :attachment="attachment"
      />
    </div>
    <MarkdownView
      v-if="body && node.role === 'assistant'"
      :source="body"
      :streaming="!!live && !live.ended"
    />
    <p v-else-if="body" class="chat-plain">{{ body }}</p>
    <p v-if="live && !live.ended" class="chat-run-status" role="status">{{ live.status }}…</p>
    <p
      v-else-if="node.role === 'assistant' && run && run.status !== 'completed'"
      class="chat-run-status"
      :class="{ 'chat-run-error': run.status === 'failed' }"
      :role="run.status === 'failed' ? 'alert' : 'status'"
    >
      {{
        run.status === 'cancelled'
          ? '已停止生成'
          : run.status === 'interrupted'
            ? '服务重启，回复已中断'
            : run.status === 'failed'
              ? (run.error?.message ?? '生成失败')
              : '正在生成…'
      }}
      <span v-if="run.status === 'failed' && run.error" class="chat-error-code">
        错误代码：{{ run.error.code }}
      </span>
    </p>
    <TooltipProvider :delay-duration="250">
      <div
        class="chat-message-actions"
        :aria-label="node.role === 'user' ? '用户消息操作' : '助理回复操作'"
      >
        <time v-if="node.role === 'user'" :datetime="new Date(node.createdAt).toISOString()">{{
          formatMessageTime(node.createdAt, now)
        }}</time>
        <MessageAction label="复制" :disabled="!body || copying" @click="copy"
          ><CopyIcon class="ui-icon"
        /></MessageAction>
        <MessageAction
          v-if="node.role === 'user'"
          label="编辑"
          :disabled="disabled"
          @click="$emit('edit')"
          ><PencilSquareIcon class="ui-icon"
        /></MessageAction>
        <template v-else>
          <MessageAction label="重新生成" :disabled="disabled" @click="$emit('regenerate')"
            ><ArrowPathIcon class="ui-icon"
          /></MessageAction>
          <div
            v-if="branches && branches.length > 1"
            class="chat-message-branches"
            aria-label="回复分支"
          >
            <MessageAction
              label="上一个分支"
              :disabled="disabled || branchIndex <= 0"
              @click="branches[branchIndex - 1] && $emit('branch', branches[branchIndex - 1]!.id)"
              ><ChevronLeftIcon class="ui-icon"
            /></MessageAction>
            <span>{{ branchIndex + 1 }}/{{ branches.length }}</span>
            <MessageAction
              label="下一个分支"
              :disabled="disabled || branchIndex >= branches.length - 1"
              @click="branches[branchIndex + 1] && $emit('branch', branches[branchIndex + 1]!.id)"
              ><ChevronRightIcon class="ui-icon"
            /></MessageAction>
          </div>
          <time :datetime="new Date(node.createdAt).toISOString()">{{
            formatMessageTime(node.createdAt, now)
          }}</time>
        </template>
      </div>
    </TooltipProvider>
  </article>
</template>
