<script setup lang="ts">
import { ref } from 'vue'
import { EditorDialog } from '@antarestra/webui/components'
import type { InitialCredentials } from './types.js'
const props = defineProps<{ credentials: InitialCredentials }>()
const emit = defineEmits<{ close: [] }>()
const copied = ref(false)
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
  try {
    await navigator.clipboard.writeText(text())
  } catch {
    const field = document.createElement('textarea')
    field.value = text()
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    document.execCommand('copy')
    field.remove()
  }
  copied.value = true
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
    <div class="actions">
      <button class="primary" type="button" @click="copy">
        {{ copied ? '已复制' : '复制登录信息' }}
      </button>
      <button type="button" @click="emit('close')">完成</button>
    </div>
  </EditorDialog>
</template>
