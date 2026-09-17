<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from 'reka-ui'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
const props = defineProps<{
  options: { id: string; name: string }[]
  label: string
  disabled?: boolean
}>()
const value = defineModel<string>({ required: true })
const host = ref<HTMLElement>()
const portalTarget = ref<HTMLElement>()
const open = ref(false)
const options = computed(() =>
  props.options.filter((item) =>
    `${item.id} ${item.name}`.toLocaleLowerCase().includes(value.value.toLocaleLowerCase()),
  ),
)
onMounted(() => {
  portalTarget.value = host.value?.closest('dialog') ?? document.body
})
function select(selected: unknown) {
  if (typeof selected === 'string') value.value = selected
}
function focus() {
  host.value?.querySelector('input')?.focus()
}
defineExpose({ focus })
function clear() {
  value.value = ''
  host.value?.querySelector('input')?.focus()
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    open.value = false
  }
}
</script>
<template>
  <div ref="host" class="editable-select" @keydown.capture="keydown">
    <ComboboxRoot
      v-model:open="open"
      :model-value="value"
      :disabled="disabled"
      :ignore-filter="true"
      :reset-search-term-on-blur="false"
      :reset-search-term-on-select="false"
      open-on-focus
      open-on-click
      @update:model-value="select"
    >
      <ComboboxAnchor class="editable-select-anchor">
        <ComboboxInput
          v-model="value"
          :aria-label="label"
          maxlength="64"
          placeholder="输入角色 ID 或名称筛选"
        />
        <button
          v-if="value"
          type="button"
          :disabled="disabled"
          aria-label="清空角色搜索"
          @click="clear"
        >
          清空
        </button>
        <ComboboxTrigger type="button" aria-label="展开角色选项"
          ><ChevronDownIcon class="ui-icon" aria-hidden="true"
        /></ComboboxTrigger>
      </ComboboxAnchor>
      <ComboboxPortal v-if="portalTarget" :to="portalTarget">
        <ComboboxContent
          class="editable-select-content"
          position="popper"
          :side-offset="4"
          :collision-padding="12"
          @escape-key-down.stop
        >
          <ComboboxViewport>
            <ComboboxItem
              v-for="item in options"
              :key="item.id"
              :value="item.id"
              class="editable-select-option"
              ><code>{{ item.id }}</code
              ><span>{{ item.name }}</span></ComboboxItem
            >
            <p v-if="!options.length" class="editable-select-empty">
              没有匹配角色，可直接保存输入的 ID。
            </p>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
  </div>
</template>
<style>
.editable-select-anchor {
  display: flex;
  align-items: center;
  gap: 6px;
}
.editable-select-anchor input {
  flex: 1;
  min-width: 0;
}
.editable-select-content {
  width: var(--reka-combobox-trigger-width);
  max-height: min(240px, var(--reka-combobox-content-available-height));
  overflow: auto;
  background: white;
  border: 1px solid #dce3ef;
  border-radius: 6px;
  padding: 5px;
  color: #263047;
  box-shadow: 0 6px 20px #111d321a;
  z-index: 1;
}
.editable-select-option {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 10px;
  border-radius: 4px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.editable-select-option[data-highlighted] {
  background: #edf2ff;
  outline: 2px solid #315ed1;
  outline-offset: -2px;
}
.editable-select-option[data-state='checked'] {
  color: #315ed1;
  font-weight: 600;
}
.editable-select-empty {
  padding: 10px;
  font-size: 13px;
  color: #637089;
}
</style>
