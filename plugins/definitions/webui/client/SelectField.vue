<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui'
import { CheckIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/vue/24/outline'

const props = withDefaults(
  defineProps<{
    compact?: boolean
    id?: string
    options: {
      id: string
      name: string
      description?: string
      disabled?: boolean
      group?: string
    }[]
    label: string
    placeholder?: string
    searchable?: boolean
    editable?: boolean
    disabled?: boolean
    maxlength?: number
    autocomplete?: string
    emptyText?: string
  }>(),
  { placeholder: '请选择', emptyText: '没有匹配选项，请尝试其他关键词。' },
)
const groups = computed(() =>
  [...new Set(props.options.map((item) => item.group ?? ''))].map((name) => ({
    name,
    options: props.options.filter((item) => (item.group ?? '') === name),
  })),
)
const value = defineModel<string>({ required: true })
const host = ref<HTMLElement>()
const portalTarget = ref<HTMLElement>()
const open = ref(false)
const query = ref('')
const filtering = ref(false)
const display = computed(() =>
  props.editable
    ? value.value
    : (props.options.find((item) => item.id === value.value)?.name ?? ''),
)
const inputValue = computed({
  get: () => (filtering.value ? query.value : display.value),
  set: (text: string) => {
    query.value = text
    filtering.value = true
    if (props.editable) value.value = text
  },
})
const options = computed(() => {
  const term = filtering.value ? query.value.trim().toLocaleLowerCase() : ''
  return props.options.filter((item) =>
    `${item.id} ${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(term),
  )
})
onMounted(() => {
  portalTarget.value = host.value?.closest('[role="dialog"], [role="alertdialog"]') ?? document.body
})
watch(open, (isOpen) => {
  if (isOpen) {
    if (!props.editable && !filtering.value) {
      query.value = ''
      filtering.value = true
    }
    return
  }
  filtering.value = false
  query.value = ''
})
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) open.value = false
  },
)
function select(selected: unknown) {
  if (typeof selected !== 'string') return
  value.value = selected
  filtering.value = false
  open.value = false
}
function focus() {
  host.value?.querySelector<HTMLElement>('input, button')?.focus()
}
function startSearch() {
  if (props.editable || filtering.value) return
  query.value = ''
  filtering.value = true
}
function blur() {
  if (open.value) return
  filtering.value = false
  query.value = ''
}
defineExpose({ focus })
function clear() {
  inputValue.value = ''
  focus()
  open.value = true
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    event.stopPropagation()
    open.value = false
  }
}
</script>
<template>
  <div
    ref="host"
    class="ui-select"
    :class="{ 'ui-select-compact': compact }"
    @keydown.capture="keydown"
  >
    <ComboboxRoot
      v-if="searchable || editable"
      v-model:open="open"
      :model-value="value"
      :disabled="disabled"
      ignore-filter
      :reset-search-term-on-blur="false"
      :reset-search-term-on-select="false"
      open-on-click
      @update:model-value="select"
    >
      <ComboboxAnchor class="ui-select-anchor" :data-disabled="disabled || undefined">
        <ComboboxInput
          :id="id"
          v-model="inputValue"
          :aria-label="label"
          :placeholder="placeholder"
          :maxlength="maxlength"
          :autocomplete="autocomplete"
          :disabled="disabled"
          @focus="startSearch"
          @blur="blur"
        />
        <button
          v-if="inputValue && (editable || filtering)"
          type="button"
          class="ui-select-icon"
          :disabled="disabled"
          :aria-label="editable ? `清空${label}` : `清空${label}筛选`"
          @click="clear"
        >
          <XMarkIcon class="ui-icon" aria-hidden="true" />
        </button>
        <ComboboxTrigger
          type="button"
          class="ui-select-icon"
          :disabled="disabled"
          :aria-label="`展开${label}选项`"
        >
          <ChevronDownIcon class="ui-icon" aria-hidden="true" />
        </ComboboxTrigger>
      </ComboboxAnchor>
      <ComboboxPortal v-if="portalTarget" :to="portalTarget">
        <ComboboxContent
          class="ui-select-content"
          :class="{ 'ui-select-content-compact': compact }"
          position="popper"
          :side-offset="6"
          :collision-padding="12"
          @escape-key-down.stop
        >
          <ComboboxViewport>
            <ComboboxItem
              v-for="item in options"
              :key="item.id"
              :value="item.id"
              :disabled="!!item.disabled"
              class="ui-select-option"
            >
              <span class="ui-select-option-text"
                ><span>{{ item.name }}</span
                ><small v-if="item.description">{{ item.description }}</small></span
              >
              <CheckIcon v-if="item.id === value" class="ui-icon" aria-hidden="true" />
            </ComboboxItem>
            <p v-if="!options.length" class="ui-select-empty" role="status">{{ emptyText }}</p>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
    <SelectRoot
      v-else
      v-model:open="open"
      :model-value="`value:${value}`"
      :disabled="disabled"
      @update:model-value="
        (selected: unknown) => typeof selected === 'string' && select(selected.slice(6))
      "
    >
      <SelectTrigger :id="id" class="ui-select-trigger" :aria-label="label">
        <SelectValue :placeholder="placeholder" /><ChevronDownIcon
          class="ui-icon"
          aria-hidden="true"
        />
      </SelectTrigger>
      <SelectPortal v-if="portalTarget" :to="portalTarget">
        <SelectContent
          class="ui-select-content"
          :class="{ 'ui-select-content-compact': compact }"
          position="popper"
          :side-offset="6"
          :collision-padding="12"
          @escape-key-down.stop
        >
          <SelectViewport>
            <SelectGroup v-for="group in groups" :key="group.name">
              <SelectLabel v-if="group.name" class="ui-select-group">{{ group.name }}</SelectLabel>
              <SelectItem
                v-for="item in group.options"
                :key="item.id"
                :value="`value:${item.id}`"
                :disabled="!!item.disabled"
                class="ui-select-option"
              >
                <SelectItemText class="ui-select-option-text">{{ item.name }}</SelectItemText>
                <CheckIcon v-if="item.id === value" class="ui-icon" aria-hidden="true" />
              </SelectItem>
            </SelectGroup>
            <p v-if="!options.length" class="ui-select-empty" role="status">暂无可选项。</p>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
  </div>
</template>
<style>
.ui-select,
.ui-select-content {
  --select-border: #d8dee9;
  --select-radius: 7px;
  --select-surface: #fff;
  --select-text: #263047;
}
.ui-select {
  width: 100%;
  min-width: 0;
}
.ui-select .ui-select-anchor,
.ui-select .ui-select-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--select-border);
  border-radius: var(--select-radius);
  background: var(--select-surface);
  color: var(--select-text);
  box-sizing: border-box;
}
.ui-select .ui-select-trigger {
  justify-content: space-between;
  padding: 10px 12px;
  text-align: left;
  font: inherit;
}
.ui-select-trigger > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.ui-select .ui-select-anchor {
  padding: 0 6px 0 12px;
}
.ui-select .ui-select-anchor input {
  flex: 1;
  width: 0;
  min-width: 0;
  padding: 10px 0;
  border: 0;
  border-radius: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  box-shadow: none;
}
.ui-select .ui-select-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  border: 0;
  background: transparent;
  color: #637089;
  border-radius: 4px;
  flex-shrink: 0;
}
.ui-select .ui-select-icon:hover:not(:disabled) {
  background: #edf2ff;
  color: #315ed1;
}
.ui-select-anchor:hover:not([data-disabled]),
.ui-select-trigger:hover:not(:disabled) {
  border-color: #9aabc7;
}
.ui-select-anchor:focus-within,
.ui-select-trigger:focus-visible {
  outline: 2px solid var(--focus-ring, #315ed1);
  outline-offset: 2px;
}
.ui-select-anchor[data-disabled],
.ui-select-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ui-select-content {
  box-sizing: border-box;
  width: var(--reka-combobox-trigger-width, var(--reka-select-trigger-width));
  max-width: calc(100vw - 24px);
  max-height: min(
    300px,
    var(--reka-combobox-content-available-height, var(--reka-select-content-available-height))
  );
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--select-border);
  border-radius: var(--select-radius);
  background: var(--select-surface);
  color: var(--select-text);
  font:
    14px 'Segoe UI',
    'Microsoft YaHei',
    sans-serif;
  box-shadow: 0 8px 24px #111d3224;
  z-index: 30;
}
.ui-select-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 10px;
  border-radius: 4px;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.ui-select-option-text {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}
.ui-select-option-text small {
  color: #637089;
  font-size: 12px;
}
.ui-select-option[data-highlighted] {
  background: #edf2ff;
  outline: 2px solid #315ed1;
  outline-offset: -2px;
}
.ui-select-option[data-state='checked'] {
  color: #315ed1;
  font-weight: 600;
}
.ui-select-option[data-disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
.ui-select-empty {
  padding: 12px;
  margin: 0;
  line-height: 1.6;
  color: #637089;
}
.ui-select-group {
  padding: 10px;
  color: #637089;
  font-size: 12px;
  font-weight: 600;
}
.ui-select.ui-select-compact .ui-select-trigger {
  min-height: 36px;
  padding: 6px 10px;
  border-color: transparent;
  background: transparent;
}
.ui-select.ui-select-compact .ui-select-trigger:hover:not(:disabled) {
  background: #f1f2f4;
}
.ui-select-compact .ui-select-trigger > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-select-content-compact {
  min-width: 220px;
}
.ui-select-content-compact .ui-select-option[data-highlighted] {
  outline: none;
  background: #efefec;
}
.ui-select-content-compact .ui-select-option:focus-visible {
  outline: none;
  background: #efefec;
}
.ui-select-content-compact .ui-select-group {
  background: #f1f2f4;
  color: #637089;
  border-radius: 4px;
  padding: 6px 10px;
  margin: 4px 0;
}
</style>
