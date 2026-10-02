<script setup lang="ts">
import type { MessageNode } from '@antarestra/contracts'
import FeedbackHost from '../../plugins/definitions/webui/client/FeedbackHost.vue'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import { contextRun } from './context-run.js'
const calls = ['available', 'expired', 'failure'].map((id) => ({
  type: 'tool-call' as const,
  id,
  name: 'web_screenshot',
  arguments: { pageId: id },
}))
const run = contextRun({
  status: 'completed',
  createdAt: Date.now() - 82000,
  endedAt: Date.now(),
  messages: [
    { role: 'assistant', content: calls },
    ...calls.map((call) => ({
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          id: call.id,
          content: {
            title: '网页截图验证',
            description: '验证已保存、已过期和暂时不可访问的截图；实时与历史使用同一组件。'.repeat(
              5,
            ),
          },
          isError: false,
          images: [
            {
              type: 'image' as const,
              resourceId: call.id,
              filename: `${call.id}截图.png`,
              mimeType: 'image/png',
              width: 800,
              height: 450,
              size: 4000,
            },
          ],
        },
      ],
    })),
  ],
})
const node: MessageNode = {
  id: 'preview',
  role: 'assistant',
  runId: run.id,
  conversationId: 'preview',
  parentId: null,
  version: 1,
  versionCount: 1,
  createdAt: Date.now(),
  content: [...calls, { type: 'text', text: '已保存截图，可以展开工具详情查看。' }],
}
</script>
<template>
  <FeedbackHost
    ><main class="web-tools-preview">
      <h1>工具图片交互验证</h1>
      <p>模拟资源响应，使用实际聊天与附件组件。</p>
      <ChatMessage :node="node" :run="run" /></main
  ></FeedbackHost>
</template>
<style scoped>
.web-tools-preview {
  max-width: 800px;
  margin: 24px auto;
  padding: 16px;
}
h1 {
  font-size: 24px;
}
</style>
