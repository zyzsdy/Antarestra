<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ContextBudget } from '@antarestra/contracts'
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from '@antarestra/webui/components'
const props = defineProps<{ budget?: ContextBudget | undefined; model: string }>()
const open = ref(false)
const ratio = computed(() =>
  props.budget ? Math.min(1, props.budget.used / props.budget.window) : 0,
)
const previous = computed(
  () =>
    props.budget &&
    JSON.stringify([props.budget.model.providerId, props.budget.model.modelId]) !== props.model,
)
const number = (value: number) => value.toLocaleString('zh-CN')
</script>
<template>
  <TooltipProvider
    ><TooltipRoot v-model:open="open">
      <TooltipTrigger as-child>
        <button
          type="button"
          class="chat-context-meter"
          :class="{ 'is-full': ratio >= 1 }"
          aria-label="查看上下文预算"
          @click="open = !open"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" class="chat-context-track" />
            <circle
              cx="12"
              cy="12"
              r="8"
              pathLength="100"
              :stroke-dasharray="`${ratio * 100} 100`"
              transform="rotate(-90 12 12)"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipPortal
        ><TooltipContent class="chat-context-tooltip" side="top" :side-offset="8">
          <template v-if="budget">
            <p>
              {{ previous ? '上次请求' : '上下文窗口'
              }}{{ budget.source === 'estimate' ? '（估算）' : '（模型用量）' }}
            </p>
            <p>已用 {{ number(budget.used) }} / {{ number(budget.window) }}</p>
            <p>剩余 {{ number(budget.remaining) }} · 输出预留 {{ number(budget.reserve) }}</p>
            <p>可继续输入 {{ number(budget.available) }} token</p>
            <small>仅在请求前后更新，不包含尚未发送的草稿。</small>
          </template>
          <p v-else>上下文预算尚未计算</p>
        </TooltipContent></TooltipPortal
      >
    </TooltipRoot></TooltipProvider
  >
</template>
