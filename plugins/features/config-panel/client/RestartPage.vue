<script setup lang="ts">
import RestartAction from './RestartAction.vue'
</script>
<template>
  <section>
    <p>重新读取主配置并重启服务端进程。执行前需要再次验证当前账号密码。</p>
    <RestartAction />
  </section>
</template>
