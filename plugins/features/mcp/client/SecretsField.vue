<script setup lang="ts">
import { ref } from 'vue'
import { Toggle } from '@antarestra/webui/components'
import { EyeIcon, EyeSlashIcon, PlusIcon, TrashIcon } from '@antarestra/webui/icons'
export interface SecretRow {
  key: string
  value: string
  saved: boolean
}
const rows = defineModel<SecretRow[]>({ required: true })
defineProps<{ id: string; label: string; disabled: boolean; invalid: string }>()
const visible = ref(false)
</script>
<template>
  <section class="mcp-secrets">
    <div class="mcp-actions">
      <h3 :id="id">{{ label }}</h3>
      <Toggle
        v-model="visible"
        type="button"
        :disabled="disabled"
        :aria-label="visible ? `隐藏${label}新值` : `显示${label}新值`"
      >
        <component :is="visible ? EyeSlashIcon : EyeIcon" class="ui-icon" aria-hidden="true" />
      </Toggle>
    </div>
    <div v-for="(row, index) in rows" :key="index" class="mcp-secret-row">
      <input
        :id="`${id}-key-${index}`"
        :aria-invalid="invalid === `${id}-key-${index}`"
        aria-describedby="mcp-validation"
        v-model="row.key"
        :aria-label="`${label}名称 ${index + 1}`"
        :readonly="row.saved"
        :disabled="disabled"
        placeholder="名称"
      />
      <input
        :id="`${id}-value-${index}`"
        :aria-invalid="invalid === `${id}-value-${index}`"
        aria-describedby="mcp-validation"
        v-model="row.value"
        :type="visible ? 'text' : 'password'"
        autocomplete="new-password"
        :aria-label="`${label}值 ${index + 1}`"
        :disabled="disabled"
        :placeholder="row.saved ? '已保存，留空保留' : '值'"
      />
      <button
        type="button"
        :disabled="disabled"
        :aria-label="`删除${label} ${index + 1}`"
        @click="rows.splice(index, 1)"
      >
        <TrashIcon class="ui-icon" aria-hidden="true" />
      </button>
    </div>
    <button
      type="button"
      :disabled="disabled || rows.length >= 100"
      @click="rows.push({ key: '', value: '', saved: false })"
    >
      <PlusIcon class="ui-icon" aria-hidden="true" />添加{{ label }}
    </button>
    <p class="mcp-hint">值默认隐藏。已保存的值留空保留；删除整行并保存后移除。</p>
  </section>
</template>
