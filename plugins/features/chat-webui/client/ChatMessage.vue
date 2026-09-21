<script setup lang="ts">
import { computed } from 'vue'
import type { ContentBlock, MessageNode, RunRecord } from '@antarestra/contracts'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@antarestra/webui/components'
import { ChevronDownIcon } from '@antarestra/webui/icons'
import type { ReplyState } from './stream.js'
const props = defineProps<{
  node: MessageNode
  run?: RunRecord | undefined
  live?: ReplyState | undefined
}>()
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
  >
    <CollapsibleRoot
      v-if="node.role === 'assistant' && (thoughts || tools.length)"
      class="chat-details"
    >
      <CollapsibleTrigger class="chat-detail-trigger"
        ><ChevronDownIcon class="ui-icon" />思考与工具详情</CollapsibleTrigger
      >
      <CollapsibleContent>
        <p v-if="thoughts" class="chat-plain">{{ thoughts }}</p>
        <div v-for="tool in tools" :key="tool.id" class="chat-tool">
          <strong>{{ tool.name }} · {{ tool.status }}</strong>
          <pre>{{ tool.detail }}</pre>
        </div>
      </CollapsibleContent>
    </CollapsibleRoot>
    <p v-if="body" class="chat-plain">{{ body }}</p>
    <p v-if="live && !live.ended" class="chat-run-status" role="status">{{ live.status }}…</p>
    <p
      v-else-if="node.role === 'assistant' && run && run.status !== 'completed'"
      class="chat-run-status"
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
    </p>
  </article>
</template>
