<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AiEvent, ChatMessage as Message, MessageNode } from '@antarestra/contracts'
import FeedbackHost from '../../plugins/definitions/webui/client/FeedbackHost.vue'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import { applyEvent, emptyReply } from '../../plugins/features/chat-webui/client/stream.js'
import { contextRun } from './context-run.js'

const state = ref(emptyReply())
const history = ref(false)
const narrow = ref(false)
const run = ref(contextRun())
const node = computed<MessageNode>(() => ({
  id: 'reply',
  role: 'assistant',
  conversationId: 'preview',
  runId: 'preview',
  parentId: null,
  version: 1,
  versionCount: 1,
  createdAt: run.value.createdAt,
  content: state.value.completed,
}))
function emit(type: AiEvent['type'], data: AiEvent['data'] | Message) {
  applyEvent(state.value, {
    type,
    data: JSON.parse(JSON.stringify(data)) as AiEvent['data'],
    sequence: state.value.sequence + 1,
    runId: 'preview',
    conversationId: 'preview',
    workspaceId: 'preview',
    createdAt: Date.now(),
  })
}
function start() {
  history.value = false
  state.value = emptyReply()
  run.value = contextRun({ status: 'running', createdAt: Date.now(), endedAt: null })
  const call = {
    type: 'tool-call' as const,
    id: 'memory-call',
    name: 'global_memory',
    arguments: { action: 'append', content: '用户偏好简体中文。需要保存重要事实，遗忘过时资料。' },
  }
  const message: Message = {
    role: 'assistant',
    content: [
      { type: 'thinking', text: '保留稳定偏好，合并重复资料。' },
      { type: 'text', text: '正在将重要偏好写入全局记忆。' },
      call,
    ],
  }
  run.value.messages = [message]
  emit('message', message)
  emit('tool-start', call)
  emit('request', { purpose: 'memory' })
}
function finish(failed: boolean) {
  if (state.value.ended) start()
  const result: Message = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        id: 'memory-call',
        isError: failed,
        content: failed
          ? { code: 'memory_budget_exceeded', error: '整理后的记忆仍超过预算，原记忆保持不变' }
          : {
              content: '用户偏好简体中文。',
              tokens: 8,
              budget: 4096,
              revision: 2,
              compacted: true,
            },
      },
    ],
  }
  run.value.messages.push(result)
  emit('tool-end', result)
  const answer: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: failed ? '整理未成功，已保留原记忆。' : '已保存重要偏好。' }],
  }
  run.value.messages.push(answer)
  emit('message', answer)
  emit('run-end', { status: 'completed' })
  run.value.status = 'completed'
  run.value.endedAt = Date.now()
}
start()
</script>
<template>
  <FeedbackHost>
    <main :class="['memory-preview', { narrow }]">
      <h1>记忆整理交互验证</h1>
      <p>模拟事件驱动实际聊天组件，不请求模型。</p>
      <div class="controls">
        <button type="button" @click="start">开始整理</button>
        <button type="button" @click="finish(false)">整理成功</button>
        <button type="button" @click="finish(true)">整理失败</button>
        <label><input v-model="history" type="checkbox" :disabled="!state.ended" />查看历史</label>
        <label><input v-model="narrow" type="checkbox" />窄屏容器</label>
      </div>
      <p role="status">{{ history ? '历史记录' : state.status }}</p>
      <ChatMessage :node="node" :run="run" :live="history ? undefined : state" />
    </main>
  </FeedbackHost>
</template>
<style scoped>
.memory-preview {
  max-width: 760px;
  margin: 24px auto;
  padding: 16px;
}
.memory-preview.narrow {
  max-width: 390px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
</style>
