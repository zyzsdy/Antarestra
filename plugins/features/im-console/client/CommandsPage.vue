<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { feedbackKey } from '@antarestra/webui/client'
import { PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon, PlusIcon } from '@antarestra/webui/icons'
import type { CommandPolicy, CommandSummary } from '@antarestra/plugin-im-commands'
import CommandPolicyEditor from './CommandPolicyEditor.vue'
import CommandAliasEditor from './CommandAliasEditor.vue'
import './style.css'

const { api, router } = useApi()
const feedback = inject(feedbackKey)!
const addingAlias = ref(false),
  deletingAlias = ref(false)
const addButton = ref<HTMLButtonElement>()
const rows = ref<CommandSummary[]>([]),
  total = ref(0),
  prefix = ref('/')
const loaded = ref(false),
  loading = ref(false),
  message = ref('')
const editing = ref<Pick<CommandSummary, 'name'>>(),
  input = ref<HTMLInputElement>()
const search = ref(''),
  composing = ref(false)
const query = computed(() => String(router.currentRoute.value.query.search ?? '').slice(0, 200))
const page = computed(() => {
  const value = Number(router.currentRoute.value.query.page)
  return Number.isSafeInteger(value) && value > 0 ? value : 1
})
let request = 0
let trigger: HTMLButtonElement | undefined
async function load() {
  const current = ++request
  loading.value = true
  message.value = ''
  try {
    const data = await api<{
      commands: CommandSummary[]
      total: number
      prefix: string
      offset: number
    }>(`/im/commands?offset=${(page.value - 1) * 20}&search=${encodeURIComponent(query.value)}`)
    if (current !== request) return
    rows.value = data.commands
    total.value = data.total
    prefix.value = data.prefix
    loaded.value = true
    if (data.offset !== (page.value - 1) * 20)
      await router.replace({
        query: { ...router.currentRoute.value.query, page: String(data.offset / 20 + 1) },
      })
  } catch (error) {
    if (current === request)
      message.value = error instanceof Error ? error.message : '命令列表加载失败'
  } finally {
    if (current === request) loading.value = false
  }
}
function navigate(nextPage = 1, term = query.value) {
  const target = {
    ...router.currentRoute.value.query,
    search: term || undefined,
    page: String(nextPage),
  }
  if (page.value === nextPage && query.value === term) void load()
  else void router.push({ query: target })
}
function submitSearch() {
  if (!composing.value) navigate(1, search.value.trim())
}
function clearSearch() {
  search.value = ''
  navigate(1, '')
  input.value?.focus()
}
function edit(item: CommandSummary, event: MouseEvent) {
  trigger = event.currentTarget as HTMLButtonElement
  editing.value = item
}
async function onSaved() {
  editing.value = undefined
  await load()
  await nextTick()
  if (trigger?.isConnected) trigger.focus()
}
async function aliasSaved(name: string) {
  addingAlias.value = false
  await nextTick()
  // 新别名默认禁用，直接进入现有权限编辑器。
  trigger = addButton.value
  editing.value = { name }
  await load()
}
async function removeAlias(item: CommandSummary) {
  if (!item.alias || deletingAlias.value) return
  deletingAlias.value = true
  try {
    if (
      !(await feedback.modal(
        `删除命令别名 ${prefix.value}${item.name}？`,
        '该别名及其独立权限将删除，目标命令不受影响。',
      ))
    )
      return
    await api(
      `/im/command-aliases/${encodeURIComponent(item.name)}`,
      { id: item.alias.id },
      'DELETE',
    )
    feedback.toast('命令别名已删除')
    await load()
    deletingAlias.value = false
    await nextTick()
    addButton.value?.focus()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '命令别名删除失败'
  } finally {
    deletingAlias.value = false
  }
}
function listSummary(list: CommandPolicy['group']) {
  return list.mode === 'whitelist'
    ? list.ids.length
      ? `白名单 · 允许 ${list.ids.length} 个`
      : '白名单 · 禁止所有'
    : list.ids.length
      ? `黑名单 · 禁止 ${list.ids.length} 个`
      : '黑名单 · 允许所有'
}
watch(
  [page, query],
  () => {
    search.value = query.value
    void load()
  },
  { immediate: true },
)
onUnmounted(() => {
  request++
})
</script>

<template>
  <div class="im-page">
    <div class="im-toolbar">
      <p class="im-hint">统一管理已注册指令的使用范围，保存后立即生效。</p>
      <button :disabled="loading" aria-label="刷新命令列表" title="刷新命令列表" @click="load">
        <ArrowPathIcon class="ui-icon" />
      </button>
      <button
        ref="addButton"
        :disabled="!loaded || loading || deletingAlias"
        @click="addingAlias = true"
      >
        <PlusIcon class="ui-icon" />添加命令别名
      </button>
    </div>
    <p class="im-panel im-hint">
      新指令默认使用空白名单，禁止所有群聊和私聊使用。群主和 bot
      管理员也须通过名单；私聊不检查授权级别。
    </p>
    <p v-if="message" class="im-error" role="alert">
      {{ message }} <button :disabled="loading" @click="load">重试</button>
    </p>
    <section class="im-panel" :aria-busy="loading">
      <form class="im-toolbar" novalidate @submit.prevent="submitSearch">
        <label for="command-search">搜索指令</label>
        <input
          id="command-search"
          ref="input"
          v-model="search"
          maxlength="200"
          placeholder="指令名称或说明"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        />
        <button type="submit" :disabled="loading">查询</button>
        <button v-if="search || query" type="button" :disabled="loading" @click="clearSearch">
          清空搜索
        </button>
        <span role="status">共 {{ total }} 条</span>
      </form>
      <div class="im-command-results">
        <p v-if="loading" role="status">正在加载命令列表…</p>
        <p v-else-if="!loaded" class="im-hint">命令列表尚未加载，请重试。</p>
        <p v-else-if="!rows.length" role="status" class="im-hint">
          {{
            query
              ? '没有匹配的指令，请调整搜索条件。'
              : '尚无已注册指令。启用提供指令的插件后，刷新即可显示。'
          }}
        </p>
        <div v-if="rows.length" class="im-table">
          <table>
            <thead>
              <tr>
                <th>指令</th>
                <th>授权级别</th>
                <th>群聊权限</th>
                <th>私聊权限</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in rows" :key="item.name">
                <td>
                  <strong>{{ prefix }}{{ item.name }}</strong
                  ><small>{{ item.description }}</small
                  ><small v-if="item.usage"
                    >用法：{{ prefix }}{{ item.name }} {{ item.usage }}</small
                  >
                  <small v-if="item.alias && !item.alias.available" class="im-error"
                    >目标命令不可用，请检查所属插件。</small
                  >
                </td>
                <td>{{ item.policy.access === 'bot-admin' ? 'bot 管理员' : '普通群友' }}</td>
                <td>{{ listSummary(item.policy.group) }}</td>
                <td>{{ listSummary(item.policy.private) }}</td>
                <td>
                  <div class="im-command-actions">
                    <button
                      :disabled="loading"
                      :aria-label="`配置 ${prefix}${item.name} 权限`"
                      @click="edit(item, $event)"
                    >
                      配置权限
                    </button>
                    <button
                      v-if="item.alias"
                      :disabled="loading || deletingAlias"
                      :aria-label="`删除别名 ${prefix}${item.name}`"
                      @click="removeAlias(item)"
                    >
                      删除别名
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <PaginationField
        v-if="total > 20"
        :page="page"
        :total="total"
        :page-size="20"
        :disabled="loading"
        label="命令列表分页"
        @update:page="navigate($event)"
      />
    </section>
    <CommandPolicyEditor
      v-if="editing"
      :key="editing.name"
      :name="editing.name"
      :prefix="prefix"
      @close="editing = undefined"
      @saved="onSaved"
    />
    <CommandAliasEditor
      v-if="addingAlias"
      :prefix="prefix"
      @close="addingAlias = false"
      @saved="aliasSaved"
    />
  </div>
</template>
