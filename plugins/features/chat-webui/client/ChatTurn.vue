<script setup lang="ts">
import { computed } from 'vue'
import type { MessageNode, RunRecord } from '@antarestra/contracts'
import ChatMessage from './ChatMessage.vue'
import { emptyReply, type ReplyState } from './stream.js'
import { historyToolDetails } from './tool-details.js'
import { turnMessages } from './turn-messages.js'
const props = defineProps<{
  node: MessageNode
  run?: RunRecord | undefined
  live?: ReplyState | undefined
  disabled?: boolean
  branches?: MessageNode[]
}>()
const emit = defineEmits<{ edit: []; regenerate: []; branch: [id: string] }>()
const hasSteering = computed(() => !!props.run?.steering?.length || !!props.live?.steering.length)
const parts = computed(() => {
  if (props.node.role !== 'assistant') return []
  const entries = new Map((props.run?.steering ?? []).map((entry) => [entry.id, entry]))
  for (const entry of props.live?.steering ?? []) {
    if (entry.position !== null || entries.get(entry.id)?.position == null)
      entries.set(entry.id, entry)
  }
  const content = props.live ? [...props.live.completed, ...props.live.pending] : props.node.content
  const tools = props.live?.tools ?? historyToolDetails(props.run)
  const operations = props.live?.contextOperations ?? props.run?.contextOperations ?? []
  return turnMessages(props.node, content, [...entries.values()]).map((part) => {
    const ids = new Set(
      part.node.content.flatMap((block) =>
        block.type === 'tool-call' || block.type === 'provider-tool' ? [block.id] : [],
      ),
    )
    return {
      ...part,
      live: {
        ...emptyReply(),
        ...props.live,
        completed: part.node.content,
        pending: [],
        ended: props.live ? props.live.ended : props.run?.status !== 'running',
        tools: tools.filter((tool) => ids.has(tool.id)),
        contextOperations: operations
          .filter(
            (operation) =>
              operation.position >= part.start &&
              (operation.position < part.end || (!part.partial && operation.position === part.end)),
          )
          .map((operation) => ({ ...operation, position: operation.position - part.start })),
      } satisfies ReplyState,
    }
  })
})
</script>

<template>
  <ChatMessage
    v-if="node.role === 'user' || !hasSteering"
    v-bind="props"
    :branches="branches ?? []"
    @edit="emit('edit')"
    @regenerate="emit('regenerate')"
    @branch="emit('branch', $event)"
  />
  <template v-else>
    <ChatMessage
      v-for="part in parts"
      :key="part.node.id"
      :node="part.node"
      :run="part.steering ? undefined : run"
      :live="part.steering ? undefined : part.live"
      :steering="part.steering"
      :partial="part.partial"
      :disabled="disabled"
      :branches="part.partial || part.steering ? [] : (branches ?? [])"
      @regenerate="emit('regenerate')"
      @branch="emit('branch', $event)"
    />
  </template>
</template>
