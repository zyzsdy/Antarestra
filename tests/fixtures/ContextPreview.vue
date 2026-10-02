<script setup lang="ts">
import { ref } from 'vue'
import type { ContextBudget, MessageNode } from '@antarestra/contracts'
import { contextRun } from './context-run.js'
import { SelectField } from '@antarestra/webui/components'
import FeedbackHost from '../../plugins/definitions/webui/client/FeedbackHost.vue'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import ContextMeter from '../../plugins/features/chat-webui/client/ContextMeter.vue'
const model = ref('["preview","model"]')
const showBudget = ref(true)
const modelOptions = [
  { id: '["preview","model"]', name: '当前模型' },
  { id: '["preview","other"]', name: '切换模型' },
]
const run = ref(
  contextRun({
    id: 'preview',
    status: 'completed',
    createdAt: 0,
    endedAt: 82000,
    messages: [],
    contextOperations: [
      {
        id: 'trim',
        kind: 'trim',
        status: 'completed',
        position: 0,
        before: 169000,
        after: 16000,
        createdAt: 0,
        endedAt: 1000,
      },
      {
        id: 'compact',
        kind: 'compact',
        status: 'completed',
        position: 1,
        before: 131000,
        after: 3000,
        createdAt: 1000,
        endedAt: 80000,
      },
    ],
  }),
)
const node: MessageNode = {
  id: 'reply',
  role: 'assistant',
  runId: 'preview',
  conversationId: 'preview',
  parentId: null,
  version: 1,
  versionCount: 1,
  createdAt: Date.now(),
  content: [
    { type: 'text', text: '继续处理前先整理上下文。' },
    { type: 'text', text: '这里始终展示原始回复内容，压缩摘要不会替换历史消息。' },
  ],
}
const budget: ContextBudget = {
  model: { providerId: 'preview', modelId: 'model' },
  window: 200000,
  used: 160000,
  remaining: 40000,
  reserve: 16000,
  available: 24000,
  phase: 'after',
  source: 'usage',
  createdAt: Date.now(),
}
</script>
<template>
  <FeedbackHost
    ><main class="context-preview">
      <h1>上下文管理交互验证</h1>
      <p>本页使用模拟记录验证实际聊天组件，不请求模型。</p>
      <label><input v-model="showBudget" type="checkbox" />显示上下文预算数据</label>
      <ChatMessage :node="node" :run="run" />
      <form class="chat-composer" @submit.prevent>
        <label for="preview-input">消息</label
        ><textarea id="preview-input" placeholder="输入消息" style="resize: none; width: 100%" />
        <div class="chat-composer-toolbar">
          <button type="button">添加附件</button>
          <div class="chat-model-controls">
            <ContextMeter :budget="showBudget ? budget : undefined" :model="model" />
            <SelectField v-model="model" label="模型" :options="modelOptions" />
          </div>
        </div>
      </form></main
  ></FeedbackHost>
</template>
<style scoped>
.context-preview {
  max-width: 760px;
  margin: 32px auto;
  padding: 16px;
}
h1 {
  font-size: 22px;
}
.chat-composer {
  margin-top: 30px;
}
</style>
