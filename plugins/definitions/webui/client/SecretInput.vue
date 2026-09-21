<script setup lang="ts">
import { ref } from 'vue'
import { Toggle } from 'reka-ui'
import { EyeIcon, EyeSlashIcon } from '../src/icons.js'
defineOptions({ inheritAttrs: false })
defineProps<{ label: string; disabled?: boolean }>()
const value = defineModel<string>({ required: true })
const visible = ref(false)
</script>
<template>
  <span class="ui-secret-input">
    <input
      v-bind="$attrs"
      v-model="value"
      class="ui-secret-control"
      :type="visible ? 'text' : 'password'"
      :disabled="disabled"
    />
    <Toggle
      v-model="visible"
      class="ui-secret-toggle"
      type="button"
      :disabled="disabled"
      :aria-label="(visible ? '隐藏' : '显示') + label"
      :title="(visible ? '隐藏' : '显示') + label"
    >
      <EyeSlashIcon v-if="visible" class="ui-icon" aria-hidden="true" />
      <EyeIcon v-else class="ui-icon" aria-hidden="true" />
    </Toggle>
  </span>
</template>
<style>
.ui-secret-input {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
}
.ui-secret-input input.ui-secret-control {
  width: 100%;
  min-width: 0;
  padding-right: 46px;
}
.ui-secret-input button.ui-secret-toggle {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #637089;
  cursor: pointer;
}
.ui-secret-input button.ui-secret-toggle:hover:not(:disabled) {
  background: #edf2ff;
  color: #315ed1;
}
.ui-secret-input button.ui-secret-toggle:active:not(:disabled) {
  background: #dfe8fb;
}
.ui-secret-input button.ui-secret-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
