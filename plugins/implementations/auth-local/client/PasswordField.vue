<script setup lang="ts">
import { ref } from 'vue'
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
  <label
    >{{ label }}
    <span class="password-field"
      ><input
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
      /><button
        type="button"
        :disabled="disabled"
        :aria-label="visible ? `隐藏${label}` : `显示${label}`"
        :aria-pressed="visible"
        @click="visible = !visible"
      >
        {{ visible ? '隐藏' : '显示' }}
      </button></span
    >
  </label>
</template>
