<script setup lang="ts">
withDefaults(defineProps<{ decorative?: boolean; size?: number }>(), {
  decorative: false,
  size: 36,
})
</script>

<template>
  <img
    class="antarestra-logo"
    :src="'/brand/logo.svg'"
    :alt="decorative ? '' : 'Antarestra'"
    width="96"
    height="80"
    draggable="false"
    :style="{ width: `${size}px`, height: `${(size * 5) / 6}px` }"
  />
</template>

<style scoped>
.antarestra-logo {
  display: inline-block;
  width: 36px;
  height: 30px;
  object-fit: contain;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
