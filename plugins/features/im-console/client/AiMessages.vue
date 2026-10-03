<script setup lang="ts">
import type { ChatMessage } from '@antarestra/contracts'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@antarestra/webui/components'
defineProps<{ messages: ChatMessage[] }>()
const roles = { user: '用户输入', assistant: 'AI 返回', tool: '工具返回' }
const json = (value: unknown) => JSON.stringify(value, null, 2)
</script>
<template>
  <div v-for="(message, index) in messages" :key="index" class="im-ai-message">
    <strong>{{ roles[message.role] }}</strong>
    <template v-for="(block, blockIndex) in message.content" :key="blockIndex">
      <p v-if="block.type === 'text'" class="im-history-text">{{ block.text }}</p>
      <CollapsibleRoot v-else-if="block.type === 'thinking'" class="im-history-disclosure"
        ><CollapsibleTrigger>思考内容</CollapsibleTrigger
        ><CollapsibleContent>
          <pre>{{ block.text }}</pre>
        </CollapsibleContent></CollapsibleRoot
      >
      <CollapsibleRoot v-else-if="block.type === 'tool-call'" class="im-history-disclosure"
        ><CollapsibleTrigger>调用工具：{{ block.name }}</CollapsibleTrigger
        ><CollapsibleContent
          ><p class="im-hint">调用 ID：{{ block.id }}</p>
          <pre>{{ json(block.arguments) }}</pre>
        </CollapsibleContent></CollapsibleRoot
      >
      <CollapsibleRoot v-else-if="block.type === 'tool-result'" class="im-history-disclosure"
        ><CollapsibleTrigger>工具返回 · {{ block.isError ? '失败' : '成功' }}</CollapsibleTrigger
        ><CollapsibleContent
          ><p class="im-hint">调用 ID：{{ block.id }}</p>
          <pre>{{ json(block.content) }}</pre>
          <p v-for="file in block.images" :key="file.resourceId">
            图片：{{ file.filename }}
          </p></CollapsibleContent
        ></CollapsibleRoot
      >
      <CollapsibleRoot v-else-if="block.type === 'provider-tool'" class="im-history-disclosure"
        ><CollapsibleTrigger>模型工具：{{ block.name }} · {{ block.status }}</CollapsibleTrigger
        ><CollapsibleContent>
          <pre>{{ json(block.result) }}</pre>
        </CollapsibleContent></CollapsibleRoot
      >
      <p v-else-if="block.type === 'image' || block.type === 'file'" class="im-hint">
        {{ block.type === 'image' ? '图片' : '文件' }}：{{ block.filename || block.resourceId }}
      </p>
    </template>
  </div>
</template>
