<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ContextOperation } from '@antarestra/contracts'
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from '@antarestra/webui/components'
const props = defineProps<{ operation: ContextOperation }>()
const open = ref(false)
const verb = computed(() => (props.operation.kind === 'trim' ? '裁剪' : '压缩'))
const label = computed(() => {
  const status = props.operation.status
  return status === 'running'
    ? `正在${verb.value}上下文`
    : status === 'completed'
      ? `已${verb.value}上下文`
      : `上下文${verb.value}${status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : '已中断'}`
})
const short = (value: number) =>
  value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : String(value)
</script>
<template>
  <div class="chat-context-divider" role="status">
    <TooltipProvider
      ><TooltipRoot v-model:open="open">
        <TooltipTrigger as-child>
          <button type="button" class="chat-context-label" @click="open = !open">
            {{ label
            }}{{
              operation.after === undefined
                ? ''
                : ` ${short(operation.before)} → ${short(operation.after)}`
            }}
          </button>
        </TooltipTrigger>
        <TooltipPortal
          ><TooltipContent class="chat-context-tooltip" side="top" :side-offset="6">
            <p>
              {{ operation.before.toLocaleString('zh-CN')
              }}<template v-if="operation.after !== undefined">
                → {{ operation.after.toLocaleString('zh-CN') }}</template
              >
              token（估算，不含输出预留）
            </p>
            <p v-if="operation.error">{{ operation.error }}</p>
          </TooltipContent></TooltipPortal
        >
      </TooltipRoot></TooltipProvider
    >
  </div>
</template>
