<script setup lang="ts">
import { reactive, ref, watch, nextTick } from 'vue'
import { CheckboxField, SelectField } from '@antarestra/webui/components'
import type { ServerInput, ServerView } from '../src/types.js'
import SecretsField, { type SecretRow } from './SecretsField.vue'
const props = defineProps<{ value: ServerView | undefined; busy: boolean; error: string }>()
const emit = defineEmits<{ save: [value: ServerInput]; dirty: [value: boolean] }>()
const draft = reactive<ServerInput>({
  revision: props.value?.revision ?? 1,
  name: props.value?.name ?? '',
  description: props.value?.description ?? '',
  activationDescription: props.value?.activationDescription ?? '',
  enabled: props.value?.enabled ?? true,
  transport: props.value?.transport ?? 'streamable-http',
  url: props.value?.url ?? '',
  command: props.value?.command ?? '',
  args: props.value?.args ?? [],
  cwd: props.value?.cwd ?? '',
  prefixEnabled: props.value?.prefixEnabled ?? false,
  prefix: props.value?.prefix ?? '',
  headers: {},
  env: {},
})
const headers = ref<SecretRow[]>(
  Object.keys(props.value?.headers ?? {}).map((key) => ({ key, value: '', saved: true })),
)
const env = ref<SecretRow[]>(
  Object.keys(props.value?.env ?? {}).map((key) => ({ key, value: '', saved: true })),
)
const args = ref(JSON.stringify(draft.args))
const validation = ref('')
const invalid = ref('')
watch([draft, headers, env, args], () => emit('dirty', true), { deep: true })
async function fail(id: string, message: string) {
  invalid.value = id
  validation.value = message
  await nextTick()
  document.getElementById(id)?.focus()
}
function map(rows: SecretRow[], id: string, isHeader: boolean) {
  const result: Record<string, string | null> = Object.create(null)
  for (const [index, row] of rows.entries()) {
    const key = isHeader ? row.key.trim().toLowerCase() : row.key.trim()
    if (
      !(isHeader ? /^[!#$%&'*+.^_`|~0-9a-z-]{1,200}$/i : /^[A-Za-z_][A-Za-z0-9_]{0,199}$/).test(
        key,
      ) ||
      Object.hasOwn(result, key)
    ) {
      void fail(`${id}-key-${index}`, '请检查请求头或环境变量名称，名称不能重复。')
      return
    }
    if (isHeader && /[\r\n]/.test(row.value)) {
      void fail(`${id}-value-${index}`, '请求头值不能包含换行。')
      return
    }
    result[key] = row.saved && !row.value ? null : row.value
  }
  return result
}
function save() {
  if (props.busy) return
  validation.value = invalid.value = ''
  if (!draft.name.trim()) return void fail('mcp-name', '请输入服务器名称。')
  if (draft.transport === 'local') {
    if (!draft.command.trim()) return void fail('mcp-command', '请输入可执行程序名称或路径。')
  } else {
    try {
      const url = new URL(draft.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new Error()
    } catch {
      return void fail('mcp-url', '请输入完整的 HTTP/HTTPS 地址，不含用户名、密码或片段。')
    }
  }
  if (draft.prefixEnabled && !/^[A-Za-z0-9_-]+$/.test(draft.prefix))
    return void fail('mcp-prefix', '前缀只能包含字母、数字、下划线和短横线，且不能为空。')
  let parsed: unknown
  try {
    parsed = JSON.parse(args.value)
  } catch {
    return void fail('mcp-args', '启动参数需为 JSON 字符串数组，例如 ["-y", "包名"]。')
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string'))
    return void fail('mcp-args', '启动参数需为 JSON 字符串数组。')
  const headerValues = map(headers.value, 'mcp-headers', true)
  const envValues = map(env.value, 'mcp-env', false)
  if (!headerValues || !envValues) return
  emit('save', { ...draft, args: parsed as string[], headers: headerValues, env: envValues })
}
</script>
<template>
  <form id="mcp-editor-form" class="mcp-form" novalidate autocomplete="off" @submit.prevent="save">
    <fieldset :disabled="busy">
      <label for="mcp-name">名称</label
      ><input
        id="mcp-name"
        v-model="draft.name"
        maxlength="200"
        :aria-invalid="invalid === 'mcp-name'"
        aria-describedby="mcp-validation"
      />
      <label for="mcp-description">描述</label
      ><textarea
        style="resize: none"
        id="mcp-description"
        v-model="draft.description"
        maxlength="4000"
        rows="3"
      />
      <label for="mcp-activation">激活描述</label
      ><textarea
        style="resize: none"
        id="mcp-activation"
        v-model="draft.activationDescription"
        maxlength="8000"
        rows="3"
        placeholder="例如：需要检索项目文件、读取目录或整理资料时使用。"
        aria-describedby="mcp-activation-help"
      />
      <p id="mcp-activation-help" class="mcp-hint">
        说明模型何时应使用这组工具。当前保存为元数据，供后续工具发现、渐进式披露和 codemode 使用。
      </p>
      <label class="mcp-check"
        ><CheckboxField v-model="draft.enabled" :disabled="busy" />启用此服务器</label
      >
      <label for="mcp-transport">连接方式</label
      ><SelectField
        id="mcp-transport"
        v-model="draft.transport"
        label="连接方式"
        :disabled="busy"
        :options="[
          { id: 'local', name: 'Local（stdio）' },
          { id: 'streamable-http', name: 'Streamable HTTP' },
          { id: 'sse', name: 'SSE' },
        ]"
      />
      <template v-if="draft.transport === 'local'">
        <label for="mcp-command">可执行程序</label
        ><input
          id="mcp-command"
          v-model="draft.command"
          maxlength="4096"
          placeholder="例如 npx 或 /完整路径/node"
          :aria-invalid="invalid === 'mcp-command'"
          aria-describedby="mcp-validation mcp-command-help"
        />
        <p id="mcp-command-help" class="mcp-hint">
          在 Antarestra 所在服务器运行。程序与参数分别填写；路径含空格时无需额外加引号。
        </p>
        <label for="mcp-args">启动参数（JSON 数组）</label
        ><textarea
          style="resize: none"
          id="mcp-args"
          v-model="args"
          rows="3"
          :aria-invalid="invalid === 'mcp-args'"
          aria-describedby="mcp-validation"
        />
        <label for="mcp-cwd">工作目录</label
        ><input
          id="mcp-cwd"
          v-model="draft.cwd"
          maxlength="4096"
          placeholder="留空使用 Antarestra 工作目录"
        />
        <SecretsField
          id="mcp-env"
          v-model="env"
          label="环境变量"
          :disabled="busy"
          :invalid="invalid"
        />
      </template>
      <template v-else
        ><label for="mcp-url">服务器地址</label
        ><input
          id="mcp-url"
          v-model="draft.url"
          type="url"
          maxlength="4096"
          placeholder="https://example.com/mcp"
          :aria-invalid="invalid === 'mcp-url'"
          aria-describedby="mcp-validation"
      /></template>
      <SecretsField
        id="mcp-headers"
        v-model="headers"
        label="请求头"
        :disabled="busy"
        :invalid="invalid"
      />
      <p v-if="draft.transport === 'local'" class="mcp-hint">
        Local 通过标准输入输出通信，请求头会保存，但仅在 HTTP 或 SSE 连接时发送。
      </p>
      <label class="mcp-check"
        ><CheckboxField
          v-model="draft.prefixEnabled"
          :disabled="busy"
        />添加前缀以区分同名工具</label
      >
      <template v-if="draft.prefixEnabled"
        ><label for="mcp-prefix">自定义前缀</label
        ><input
          id="mcp-prefix"
          v-model="draft.prefix"
          maxlength="100"
          placeholder="webtools_"
          :aria-invalid="invalid === 'mcp-prefix'"
          aria-describedby="mcp-validation mcp-prefix-help"
        />
        <p id="mcp-prefix-help" class="mcp-hint">
          直接拼接到工具名前，例如 {{ draft.prefix || 'webtools_' }}get_files；完整工具名最多 64
          字符。
        </p></template
      >
    </fieldset>
    <p id="mcp-validation" class="mcp-error" role="alert">{{ validation || error }}</p>
  </form>
</template>
