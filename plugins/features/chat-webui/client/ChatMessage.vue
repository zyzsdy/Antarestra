<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { MarkdownView } from '@antarestra/plugin-markdown-render/client'
import type { ContentBlock, MessageNode, RunRecord } from '@antarestra/contracts'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
  TooltipProvider,
} from '@antarestra/webui/components'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardIcon,
  PencilSquareIcon,
  ArrowPathIcon,
} from '@antarestra/webui/icons'
import MessageAction from './MessageAction.vue'
import { formatMessageTime } from './message-time.js'
import type { ReplyState } from './stream.js'
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
    : text(content.value, 'text'),
)
const thoughts = computed(() => text(content.value, 'thinking'))
const tools = computed(() =>
  props.live
    ? props.live.tools
    : (props.run?.messages ?? [])
        .flatMap((message) => message.content)
        .flatMap((block) =>
          block.type === 'tool-call' || block.type === 'tool-result'
            ? [
                {
                  id: `${block.type}:${block.id}`,
                  name: block.type === 'tool-call' ? block.name : '工具结果',
                  status: block.type === 'tool-call' ? '调用' : block.isError ? '失败' : '完成',
                  detail: JSON.stringify(block, null, 2),
                },
              ]
            : [],
        ),
)
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
      v-if="node.role === 'assistant' && (thoughts || tools.length)"
      class="chat-details"
    >
      <CollapsibleTrigger class="chat-detail-trigger"
        ><ChevronDownIcon class="ui-icon" />思考与工具详情</CollapsibleTrigger
      >
      <CollapsibleContent>
        <MarkdownView v-if="thoughts" :source="thoughts" :streaming="!!live && !live.ended" />
        <div v-for="tool in tools" :key="tool.id" class="chat-tool">
          <strong>{{ tool.name }} · {{ tool.status }}</strong>
          <pre>{{ tool.detail }}</pre>
        </div>
      </CollapsibleContent>
    </CollapsibleRoot>
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
          ><ClipboardIcon class="ui-icon"
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
