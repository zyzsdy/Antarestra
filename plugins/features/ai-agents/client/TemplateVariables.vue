<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from '@antarestra/webui/api'

const { api, run, busy, message } = useApi()
const variables = ref<{ id: string; description: string }[]>([])
function load() {
  void run(async () => {
    variables.value = await api('/ai-agents/template-variables')
  })
}
onMounted(load)
</script>

<template>
  <p class="agents-variable-intro">将变量原样写入模板，运行时会替换为对应内容。</p>
  <p v-if="busy" role="status">正在加载可用变量…</p>
  <div v-else-if="message">
    <p class="agents-error" role="alert">{{ message }}</p>
    <button type="button" @click="load">重新加载变量</button>
  </div>
  <dl v-else class="agents-variable-list">
    <div v-for="variable in variables" :key="variable.id">
      <dt>
        <code v-text="'{{ ' + variable.id + ' }}'" />
      </dt>
      <dd>{{ variable.description }}</dd>
    </div>
  </dl>
  <p class="agents-hint agents-variable-note">
    此处列出系统内置及当前已启用插件注册的变量。自定义变量须由调用方提供，缺失时会报错。
    变量名支持字母、数字、下划线、点和连字符，不执行表达式，也不会递归替换变量内容。
  </p>
  <p class="agents-hint agents-variable-note">
    可拖动面板标题；聚焦标题后也可用方向键移动，Home 键复位。
  </p>
</template>

<style scoped>
.agents-variable-intro {
  margin: 0 0 16px;
}
.agents-variable-list {
  margin: 0;
}
.agents-variable-list > div + div {
  margin-top: 16px;
}
.agents-variable-list dt {
  color: #315ed1;
}
.agents-variable-list dd {
  margin: 4px 0 0;
}
.agents-variable-note {
  margin: 16px 0 0;
}
</style>
