<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import { EditorDialog, PaginationField, SecretInput } from '@antarestra/webui/components'
import type { CodexAccountView, CodexLoginView } from '../src/codex-types.js'
import '@antarestra/webui/ai-management.css'
import './style.css'

const { api, run, busy, message } = useApi()
const feedback = inject(feedbackKey)!
const accounts = ref<CodexAccountView[]>([])
const loaded = ref(false)
const page = ref(1)
const visible = computed(() => accounts.value.slice((page.value - 1) * 20, page.value * 20))
const login = ref<CodexLoginView>()
const callback = ref('')
const callbackError = ref('')
const selected = ref<CodexAccountView>()
const modelPage = ref(1)
const modelDialog = ref(false)
const models = computed(
  () => selected.value?.models.slice((modelPage.value - 1) * 20, modelPage.value * 20) ?? [],
)
let alive = true
let polling = false
let pollTimer: ReturnType<typeof setTimeout> | undefined
const root = '/codex-subscription'
async function load() {
  const result = await api<CodexAccountView[]>(root)
  if (alive) {
    accounts.value = result
    loaded.value = true
    page.value = Math.min(page.value, Math.max(1, Math.ceil(result.length / 20)))
  }
}
function refresh() {
  void run(load)
}
function schedulePoll() {
  clearTimeout(pollTimer)
  if (alive && login.value?.status === 'pending')
    pollTimer = setTimeout(() => {
      void poll()
    }, 2000)
}
async function poll() {
  const id = login.value?.id
  if (!id || !alive || polling) return
  polling = true
  clearTimeout(pollTimer)
  try {
    const result = await api<CodexLoginView>(`${root}/login/${id}`)
    if (!alive || login.value?.id !== id) return
    login.value = result
    if (result.status === 'completed') {
      callback.value = ''
      await load()
      if (alive) feedback.toast('ChatGPT 订阅已接入；可在聊天或 Agent 中选择对应模型')
    } else if (result.status === 'exchanging') {
      pollTimer = setTimeout(() => {
        void poll()
      }, 2000)
    } else schedulePoll()
  } catch (error) {
    if (alive && login.value?.id === id)
      message.value = error instanceof Error ? error.message : '授权状态获取失败，请刷新状态'
  } finally {
    polling = false
  }
}
function begin(accountId?: string) {
  void run(async () => {
    clearTimeout(pollTimer)
    const result = await api<CodexLoginView>(root + '/login', accountId ? { accountId } : {})
    if (!alive) return
    login.value = result
    callback.value = callbackError.value = ''
    schedulePoll()
  })
}
function complete() {
  if (!callback.value.trim()) {
    callbackError.value = '请粘贴浏览器地址栏中的完整回调地址'
    document.getElementById('codex-callback')?.focus()
    return
  }
  void run(async () => {
    const id = login.value?.id
    if (!id) return
    callbackError.value = ''
    clearTimeout(pollTimer)
    await api(`${root}/login/${id}/complete`, { callback: callback.value.trim() })
    callback.value = ''
    await poll()
  })
}
function cancel() {
  void run(async () => {
    const id = login.value?.id
    if (!id) return
    await api(`${root}/login/${id}`, {}, 'DELETE')
    clearTimeout(pollTimer)
    login.value = undefined
    callback.value = ''
  })
}
function sync(account: CodexAccountView) {
  void run(async () => {
    const result = await api<CodexAccountView[]>(`${root}/accounts/${account.id}/sync`, {})
    if (alive) {
      accounts.value = result
      feedback.toast('订阅模型已同步')
    }
  })
}
function disconnect(account: CodexAccountView) {
  void run(async () => {
    if (
      !(await feedback.modal(
        '断开 ChatGPT 订阅？',
        `将停止此账户的模型调用并清除本地令牌。保留账户标识，之后可重新授权。账户：${account.email || account.clientId}`,
      ))
    )
      return
    const result = await api<{ revoked: boolean; message: string }>(
      `${root}/accounts/${account.id}/disconnect`,
      {},
    )
    await load()
    if (!alive) return
    if (!result.revoked) message.value = result.message
    else feedback.toast(result.message)
  })
}
function showModels(account: CodexAccountView) {
  selected.value = account
  modelPage.value = 1
  modelDialog.value = true
}
onMounted(refresh)
onUnmounted(() => {
  alive = false
  clearTimeout(pollTimer)
  callback.value = ''
})
</script>

<template>
  <section class="ui-ai-management codex-subscription" :aria-busy="busy">
    <header class="page-heading">
      <div>
        <h2>账户与授权</h2>
        <p class="muted">通过官方 OAuth 接入 Codex / ChatGPT 订阅模型</p>
      </div>
      <div class="actions">
        <button :disabled="busy" @click="refresh">刷新账户</button>
        <button
          class="primary"
          data-oai-siwc-button
          :disabled="busy || login?.status === 'pending' || login?.status === 'exchanging'"
          @click="begin()"
        >
          使用 ChatGPT 继续
        </button>
      </div>
    </header>
    <p class="hint">
      无需 API Key。授权账户仅供当前 Antarestra 用户调用；聊天与 Agent
      使用同一模型目录。请使用自己的 ChatGPT 账户完成授权。
    </p>
    <p class="hint">
      <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener noreferrer"
        >在 ChatGPT 中查看用量与管理应用额度 ↗</a
      >
      · 可用模型与额度由账户套餐及官方授权范围决定。
    </p>
    <p class="codex-feedback" role="alert">{{ message }}</p>
    <section v-if="login" class="codex-login" aria-labelledby="codex-login-title">
      <h2 id="codex-login-title">连接 ChatGPT 账户</h2>
      <p role="status">
        {{
          login.status === 'pending'
            ? '等待授权，请打开官方登录页面。此链接 10 分钟内有效。'
            : login.status === 'exchanging'
              ? '正在验证授权并同步模型…'
              : login.status === 'completed'
                ? '授权完成，可在下方查看账户与模型。'
                : login.error
        }}
      </p>
      <template v-if="login.status === 'pending'">
        <a
          class="codex-login-link"
          :href="login.url"
          target="_blank"
          rel="noopener noreferrer"
          data-oai-siwc-button
          >打开 ChatGPT 官方授权页面 ↗</a
        >
        <p class="hint">
          本机运行时将自动完成。远程自托管时，若登录后浏览器提示无法连接
          127.0.0.1，请复制地址栏中的完整回调地址并粘贴到下方。不要把回调地址发给他人。
        </p>
        <p class="hint">
          本次回调地址：<code>{{ login.redirectUri }}</code>
        </p>
        <form novalidate autocomplete="off" @submit.prevent="complete">
          <label for="codex-callback">完整回调地址</label>
          <SecretInput
            id="codex-callback"
            label="回调地址"
            v-model="callback"
            :disabled="busy"
            :aria-invalid="!!callbackError"
            aria-describedby="codex-callback-error"
            autocomplete="new-password"
          />
          <p id="codex-callback-error" class="codex-feedback" role="alert">{{ callbackError }}</p>
          <div class="actions">
            <button type="submit" :disabled="busy">完成授权</button
            ><button type="button" :disabled="busy" @click="poll">刷新授权状态</button
            ><button type="button" :disabled="busy" @click="cancel">取消授权</button>
          </div>
        </form>
      </template>
      <button v-else-if="login.status !== 'exchanging'" :disabled="busy" @click="cancel">
        关闭授权状态
      </button>
    </section>
    <p v-if="!loaded" class="state" role="status">
      {{ busy ? '正在加载订阅账户…' : '账户加载失败，请刷新重试。' }}
    </p>
    <p v-else-if="!accounts.length" class="state">
      尚未连接 ChatGPT 账户。点击“使用 ChatGPT 继续”开始授权。
    </p>
    <div v-else class="codex-accounts">
      <article v-for="account in visible" :key="account.id" class="codex-account">
        <div>
          <h2>{{ account.email || 'ChatGPT 账户' }}</h2>
          <p class="hint">{{ account.id }}</p>
          <p class="hint">{{ account.clientId }}</p>
        </div>
        <p>{{ account.connected ? '已连接 · 访问令牌按需自动刷新' : '已断开 · 需要重新授权' }}</p>
        <p class="hint">
          {{ account.models.length }} 个模型<span v-if="account.expiresAt">
            · 当前令牌有效至 {{ new Date(account.expiresAt).toLocaleString('zh-CN') }}</span
          >
        </p>
        <p v-if="account.connected && !account.models.length" class="hint">
          模型目录尚未获取成功，请点击“同步模型”重试。
        </p>
        <div class="actions">
          <button :disabled="busy || !account.models.length" @click="showModels(account)">
            查看模型
          </button>
          <button :disabled="busy || !account.connected" @click="sync(account)">同步模型</button>
          <button
            :disabled="busy || login?.status === 'pending' || login?.status === 'exchanging'"
            @click="begin(account.id)"
          >
            重新授权
          </button>
          <button
            class="danger"
            :disabled="busy || !account.connected"
            @click="disconnect(account)"
          >
            断开订阅
          </button>
        </div>
      </article>
    </div>
    <PaginationField
      v-if="accounts.length > 20"
      v-model:page="page"
      :total="accounts.length"
      :page-size="20"
      :disabled="busy"
      label="订阅账户分页"
    />
    <EditorDialog v-if="modelDialog" title="订阅模型" @close="modelDialog = false">
      <p class="hint">
        {{ selected?.email }} ·
        {{
          selected?.connected
            ? `在聊天或 Agent 中选择“ChatGPT 订阅 · ${selected.id.slice(-8)}”下的模型。`
            : '此账户已断开，列表为上次保存的模型；重新授权后才能调用。'
        }}
      </p>
      <ul class="codex-models">
        <li v-for="model in models" :key="model.id">
          <strong>{{ model.title }}</strong
          ><code>{{ model.id }}</code>
        </li>
      </ul>
      <PaginationField
        v-if="(selected?.models.length ?? 0) > 20"
        v-model:page="modelPage"
        :total="selected?.models.length ?? 0"
        :page-size="20"
        label="订阅模型分页"
      />
    </EditorDialog>
  </section>
</template>
