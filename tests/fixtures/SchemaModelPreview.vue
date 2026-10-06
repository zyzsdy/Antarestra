<script setup lang="ts">
import { provide, ref } from 'vue'
import '../../plugins/features/config-panel/client/Page.vue'
import { sessionKey } from '@antarestra/webui/client'
import SchemaForm from '../../plugins/features/config-panel/client/SchemaForm.vue'
import type { Schema } from '../../plugins/features/config-panel/client/types.js'
provide(sessionKey, { read: () => null, clear() {}, set() {}, snapshot: ref(null) })
provide(Symbol.for('antarestra.webui.router'), {
  currentRoute: ref({ fullPath: '/' }),
  push: async () => {},
})
const value = ref<Record<string, unknown>>({
  model: { providerId: 'first', modelId: 'one', thinking: 'high' },
})
const schema: Schema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      title: '翻译提示词',
      'x-multiline': true,
      default: '请将帖子翻译为简体中文。\n术语词典：{dict}',
    },
    model: {
      type: 'object',
      title: '生成模型',
      'x-ai-model': true,
      properties: {
        providerId: { type: 'string' },
        modelId: { type: 'string' },
        thinking: { type: 'string' },
      },
    },
  },
}
function change(path: string[], item: unknown, remove?: boolean) {
  if (remove) delete value.value[path[0]!]
  else value.value[path[0]!] = item
}
</script>
<template>
  <main class="config-page">
    <h1>模型配置表单验证</h1>
    <p>仅使用浏览器测试注入的模型目录，不调用模型。</p>
    <SchemaForm :schema="schema" :value="value" @change="change" />
    <pre id="value">{{ JSON.stringify(value) }}</pre>
  </main>
</template>
<style scoped>
main {
  max-width: 680px;
  margin: 24px auto;
  padding: 16px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
