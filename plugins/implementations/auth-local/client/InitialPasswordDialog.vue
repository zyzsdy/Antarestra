<script setup lang="ts">
import { ref } from 'vue'
import { EditorDialog } from '@antarestra/webui/components'
import { copyText } from '@antarestra/markdown/clipboard'
import type { InitialCredentials } from './types.js'
const props = defineProps<{ credentials: InitialCredentials }>()
const emit = defineEmits<{ close: [] }>()
const copied = ref(false)
const copying = ref(false)
const copyError = ref('')
function text() {
  return [
    `登录名：${props.credentials.loginName}`,
    `用户名：${props.credentials.displayName}`,
    `初始密码：${props.credentials.initialPassword}`,
    `登录地址：${props.credentials.loginUrl}`,
    '首次登录后必须修改密码。',
  ].join('\n')
}
async function copy() {
  if (copying.value) return
  copying.value = true
  copied.value = false
  copyError.value = ''
  try {
    copied.value = await copyText(text())
    if (!copied.value) copyError.value = '复制失败，请选中上方登录信息后手动复制'
  } catch {
    copyError.value = '复制失败，请选中上方登录信息后手动复制'
  } finally {
    copying.value = false
  }
}
</script>
<template>
  <EditorDialog title="初始登录信息" @close="emit('close')">
    <p class="muted">初始密码只显示这一次。请复制后通过安全渠道交给用户。</p>
    <dl class="credentials">
      <div>
        <dt>登录名</dt>
        <dd>{{ credentials.loginName }}</dd>
      </div>
      <div>
        <dt>用户名</dt>
        <dd>{{ credentials.displayName }}</dd>
      </div>
      <div>
        <dt>初始密码</dt>
        <dd>
          <code>{{ credentials.initialPassword }}</code>
        </dd>
      </div>
      <div>
        <dt>登录地址</dt>
        <dd>{{ credentials.loginUrl }}</dd>
      </div>
    </dl>
    <p class="notice">首次登录后必须修改密码。</p>
    <p v-if="copyError" class="notice" role="alert">{{ copyError }}</p>
    <div class="actions">
      <button class="primary" type="button" :disabled="copying" @click="copy">
        {{ copying ? '正在复制…' : copied ? '已复制' : '复制登录信息' }}
      </button>
      <button type="button" @click="emit('close')">完成</button>
    </div>
  </EditorDialog>
</template>
