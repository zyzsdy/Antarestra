<script setup lang="ts">
import { computed } from 'vue'
import type { ConversationTodo } from '@antarestra/contracts'
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@antarestra/webui/components'
import { ChevronDownIcon, CheckCircleIcon, ClockIcon, ArrowPathIcon } from '@antarestra/webui/icons'

const props = defineProps<{ items: ConversationTodo[] }>()
const completed = computed(() => props.items.filter((item) => item.status === 'completed').length)
const visible = computed(() => props.items.some((item) => item.status !== 'completed'))
const statusLabels = { pending: '待完成', in_progress: '进行中', completed: '已完成' }
</script>

<template>
  <CollapsibleRoot v-if="visible" class="chat-todos" :default-open="true">
    <CollapsibleTrigger class="chat-todos-trigger">
      <span>待办列表</span>
      <span class="chat-todos-progress" role="status"
        >已完成 {{ completed }} / {{ items.length }}</span
      >
      <ChevronDownIcon class="ui-icon" />
    </CollapsibleTrigger>
    <CollapsibleContent class="chat-todos-content">
      <ol aria-label="当前会话待办列表">
        <li v-for="item in items" :key="item.id" :class="item.status">
          <component
            :is="
              item.status === 'completed'
                ? CheckCircleIcon
                : item.status === 'in_progress'
                  ? ArrowPathIcon
                  : ClockIcon
            "
            class="ui-icon"
            aria-hidden="true"
          />
          <span class="chat-todo-text">{{ item.text }}</span>
          <span class="chat-todo-status">{{ statusLabels[item.status] }}</span>
        </li>
      </ol>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
