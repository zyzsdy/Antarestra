<script setup lang="ts">
import { ref } from 'vue'
import { EyeIcon, EyeSlashIcon } from '@antarestra/webui/icons'

defineProps<{
  label: string
  name: string
  autocomplete: string
  invalid?: boolean | undefined
  describedby?: string | undefined
  disabled?: boolean | undefined
}>()
const value = defineModel<string>({ required: true })
const visible = ref(false)
</script>
<template>
  <div class="form-field">
    <label :for="name">{{ label }}</label>
    <span class="password-field">
      <input
        :id="name"
        v-model="value"
        :name="name"
        :type="visible ? 'text' : 'password'"
        :autocomplete="autocomplete"
        :aria-invalid="invalid"
        :aria-describedby="describedby"
        :disabled="disabled"
        required
        minlength="8"
        maxlength="128"
      />
      <button
        class="password-toggle"
        type="button"
        :disabled="disabled"
        :aria-label="visible ? `隐藏${label}` : `显示${label}`"
        :aria-pressed="visible"
        :title="visible ? `隐藏${label}` : `显示${label}`"
        @click="visible = !visible"
      >
        <EyeSlashIcon v-if="visible" class="ui-icon" aria-hidden="true" />
        <EyeIcon v-else class="ui-icon" aria-hidden="true" />
      </button>
    </span>
  </div>
</template>
