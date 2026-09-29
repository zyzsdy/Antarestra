<script setup lang="ts">
import {
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from '@antarestra/webui/components'

defineProps<{ label: string; disabled?: boolean }>()
defineEmits<{ click: [] }>()
</script>

<template>
  <TooltipRoot>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="chat-icon-button"
        :aria-label="label"
        :disabled="disabled"
        @click="$emit('click')"
      >
        <slot />
      </button>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent class="chat-message-tooltip" :side-offset="6" :collision-padding="12">
        {{ label }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
