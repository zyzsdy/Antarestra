<script setup lang="ts">
import { computed } from 'vue'
import type { AiHistoryDetail } from '@antarestra/im'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@antarestra/webui/components'
import AiMessages from './AiMessages.vue'
import { formatTime, jobStates, deliveryStates } from './history-format'
const props = defineProps<{ detail: AiHistoryDetail }>()
const inputRequest = computed(() =>
  props.detail.run?.requests.find((request) => !request.purpose || request.purpose === 'reply'),
)
const sentInput = computed(() => {
  const users = inputRequest.value?.messages.filter((message) => message.role === 'user') ?? []
  const current = props.detail.run?.messages.find((message) => message.role === 'user')
  // 旧快照可能没有消息 ID；新记录按 ID 匹配，避免把上一轮输入当成本轮输入。
  return current?.id && users.some((message) => message.id)
    ? users.find((message) => message.id === current.id)
    : users.at(-1)
})
const inputUnavailable = computed(() => {
  if (!props.detail.run && props.detail.runId) return '运行详情已不存在，无法读取实际模型输入。'
  if (inputRequest.value) return '回复请求快照中没有本轮用户消息。'
  return props.detail.status === 'queued' || props.detail.status === 'running'
    ? '尚未生成回复请求快照，实际模型输入暂不可用。'
    : '未保存回复请求快照，无法读取实际模型输入。'
})
</script>
<template>
  <div class="im-history-detail">
    <p>
      {{ formatTime(detail.createdAt) }} · {{ jobStates[detail.status] }} ·
      {{ detail.answer ? deliveryStates[detail.delivery] : '无待投递回复' }}
    </p>
    <p class="im-hint im-history-id">
      会话：{{ detail.conversationId || '尚未建立' }}<br />运行：{{ detail.runId || '尚未开始' }}
    </p>
    <section aria-label="发送给 AI 的输入">
      <h3>发送给 AI 的输入</h3>
      <template v-if="sentInput">
        <p class="im-hint">显示首次回复请求中的本轮用户消息；完整上下文与后续请求见下方快照。</p>
        <div class="im-sent-input" role="region" aria-label="本轮模型输入" tabindex="0">
          <AiMessages :messages="[sentInput]" />
        </div>
      </template>
      <template v-else>
        <p class="im-hint">{{ inputUnavailable }}</p>
        <CollapsibleRoot class="im-history-disclosure">
          <CollapsibleTrigger>查看原始 IM 输入（Agent 模板处理前）</CollapsibleTrigger>
          <CollapsibleContent>
            <pre>{{ detail.input }}</pre>
          </CollapsibleContent>
        </CollapsibleRoot>
      </template>
    </section>
    <h3>回复群聊的内容</h3>
    <pre v-if="detail.answer !== null">{{ detail.answer }}</pre>
    <p v-else class="im-hint">
      {{
        detail.status === 'queued' || detail.status === 'running'
          ? '尚未生成可投递的回复。'
          : '本次没有可投递的回复。'
      }}
    </p>
    <template v-if="detail.run">
      <p class="im-hint">
        模型：{{ detail.run.model.providerId }} / {{ detail.run.model.modelId
        }}<span v-if="detail.run.endedAt"> · 结束于 {{ formatTime(detail.run.endedAt) }}</span>
      </p>
      <p v-if="detail.run.error" class="im-error" role="alert">
        {{ detail.run.error.code }}：{{ detail.run.error.message }}
      </p>
      <h3>模型请求快照（{{ detail.run.requests.length }} 次）</h3>
      <p class="im-hint">展开查看各次请求的系统提示词、上下文与工具定义。</p>
      <CollapsibleRoot
        v-for="(request, index) in detail.run.requests"
        :key="index"
        class="im-history-disclosure"
      >
        <CollapsibleTrigger
          >第 {{ index + 1 }} 次请求 · {{ request.model.modelId }}</CollapsibleTrigger
        >
        <CollapsibleContent
          ><h4>系统提示词</h4>
          <pre>{{ request.systemPrompt }}</pre>
          <h4>发送的上下文</h4>
          <AiMessages :messages="request.messages" /><CollapsibleRoot class="im-history-disclosure"
            ><CollapsibleTrigger>工具定义与请求参数</CollapsibleTrigger
            ><CollapsibleContent>
              <pre>{{
                JSON.stringify(
                  {
                    thinking: request.thinking,
                    parameters: request.parameters,
                    tools: request.tools,
                  },
                  null,
                  2,
                )
              }}</pre>
            </CollapsibleContent></CollapsibleRoot
          ></CollapsibleContent
        >
      </CollapsibleRoot>
      <h3>AI 返回与工具处理记录</h3>
      <AiMessages :messages="detail.run.messages.filter((item) => item.role !== 'user')" />
      <p v-if="!detail.run.messages.some((item) => item.role !== 'user')" class="im-hint">
        尚无返回内容。
      </p>
    </template>
    <p v-else class="im-hint">
      {{
        detail.runId ? '运行详情已不存在，仍保留本次输入和群回复记录。' : '本次尚未创建 AI 运行。'
      }}
    </p>
  </div>
</template>
