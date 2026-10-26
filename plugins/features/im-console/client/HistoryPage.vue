<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { feedbackKey } from '@antarestra/webui/client'
import { useApi } from '@antarestra/webui/api'
import { PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import type { GroupSummary } from '@antarestra/im'
import GroupHistory from './GroupHistory.vue'
import GroupAdmins from './GroupAdmins.vue'
import { formatTime } from './history-format'
import './style.css'

const { api, run, busy: actionBusy, message, router, session } = useApi()
const loading = ref(false)
const busy = computed(() => actionBusy.value || loading.value)
const feedback = inject(feedbackKey)!
const archived = computed(() => router.currentRoute.value.query.archived === 'true')
const canManageHistory = computed(() =>
  session.snapshot.value?.permissions.includes('admin.im.history.manage'),
)
const adminGroup = ref<GroupSummary>()
const canManageAdmins = computed(() =>
  session.snapshot.value?.permissions.includes('admin.im.bot.manage'),
)
const groups = ref<GroupSummary[]>([])
const total = ref(0)
const loaded = ref(false)
const group = computed(() => String(router.currentRoute.value.query.group ?? ''))
const page = computed(() => Math.max(1, Number(router.currentRoute.value.query.page) || 1))
const selected = computed(() => groups.value.find((item) => item.workspaceId === group.value))
let loadVersion = 0
async function load() {
  const version = ++loadVersion
  loading.value = true
  try {
    const result = await api<{ groups: GroupSummary[]; total: number }>(
      `/im/groups?offset=${(page.value - 1) * 20}&archived=${archived.value}`,
    )
    if (version !== loadVersion) return
    if (page.value > 1 && (page.value - 1) * 20 >= result.total) {
      await router.replace({
        query: {
          ...router.currentRoute.value.query,
          page: String(Math.max(1, Math.ceil(result.total / 20))),
        },
      })
      return
    }
    groups.value = result.groups
    total.value = result.total
    loaded.value = true
  } catch (error) {
    if (version === loadVersion) throw error
  } finally {
    if (version === loadVersion) loading.value = false
  }
}
function navigate(workspaceId?: string, nextPage = page.value) {
  void router.push({
    query: {
      ...(archived.value ? { archived: 'true' } : {}),
      page: String(nextPage),
      ...(workspaceId ? { group: workspaceId } : {}),
    },
  })
}
function toggleArchive() {
  void router.push({ query: archived.value ? {} : { archived: 'true' } })
}
const confirming = ref(false)
async function setArchived(item: GroupSummary, value: boolean) {
  if (busy.value || confirming.value) return
  if (value) {
    confirming.value = true
    try {
      if (
        !(await feedback.modal(
          `归档“${item.name}”？`,
          '归档后，该群将从当前列表隐藏，可在已归档群聊中取消归档。此操作不改变 IM 接入规则。',
          { confirmLabel: '归档' },
        ))
      )
        return
    } finally {
      confirming.value = false
    }
  }
  await run(async () => {
    await api(
      `/im/groups/${encodeURIComponent(item.workspaceId)}/archive`,
      { archived: value },
      'PUT',
    )
    feedback.toast(value ? '群聊已归档' : '已取消归档')
    await load()
  })
}

async function deleteGroup(item: GroupSummary) {
  if (busy.value || confirming.value) return
  confirming.value = true
  try {
    if (
      !(await feedback.modal(
        `永久删除“${item.name}”？`,
        '该群的群记录、消息历史和 AI 会话历史将永久清除，无法恢复。此操作不改变 IM 接入规则；若仍允许接入，收到新消息后会重新建立群记录。',
        { confirmLabel: '永久删除', danger: true },
      ))
    )
      return
  } finally {
    confirming.value = false
  }
  await run(async () => {
    await api(`/im/groups/${encodeURIComponent(item.workspaceId)}`, {}, 'DELETE')
    feedback.toast('群聊及消息、AI 会话历史已永久删除')
    await load()
  })
}

watch(
  [page, archived],
  () => {
    message.value = ''
    loaded.value = false
    groups.value = []
    void load().catch((error: unknown) => {
      message.value = error instanceof Error ? error.message : '加载失败'
    })
  },
  { immediate: true },
)
</script>

<template>
  <div class="im-page">
    <template v-if="group">
      <div class="im-toolbar">
        <button @click="navigate()">返回群列表</button>
        <p class="im-hint">
          {{
            selected
              ? `${selected.platform} · ${selected.connectionId} · 群 ${selected.chatId}`
              : '群聊历史'
          }}
        </p>
      </div>
      <GroupHistory :key="group" :workspace-id="group" :name="selected?.name || group" />
    </template>
    <template v-else>
      <div class="im-toolbar">
        <p class="im-hint">
          {{
            archived
              ? '已归档群聊：取消归档后可返回群列表，永久删除无法恢复。'
              : '按群查看消息历史，以及每次 AI 处理的输入、返回和投递状态。'
          }}
        </p>
        <button :disabled="busy" title="刷新群列表" aria-label="刷新群列表" @click="run(load)">
          <ArrowPathIcon class="ui-icon" />
        </button>
        <button :disabled="busy" @click="toggleArchive">
          {{ archived ? '返回群列表' : '已归档群聊' }}
        </button>
      </div>
      <p v-if="message" class="im-error" role="alert">
        {{ message }}<button :disabled="busy" @click="run(load)">重试</button>
      </p>
      <section class="im-panel" :aria-busy="busy">
        <p v-if="!loaded" role="status">
          {{ busy ? '正在加载群列表…' : '群列表尚未加载，请重试。' }}
        </p>
        <p v-else-if="!groups.length" role="status" class="im-hint">
          {{
            archived
              ? '暂无已归档群聊。'
              : '暂无群聊记录。机器人收到准入规则允许的群消息后会显示在这里。'
          }}
        </p>
        <div v-else class="im-table">
          <table>
            <thead>
              <tr>
                <th>群聊</th>
                <th>接入</th>
                <th>最近消息</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in groups" :key="item.workspaceId">
                <td>
                  <strong>{{ item.name }}</strong>
                  <span v-if="!item.connected" class="im-stopped">已停止接入</span>
                  <small>群 {{ item.chatId }}</small>
                </td>
                <td>
                  {{ item.connectionId || '已卸载的接入' }}<small>{{ item.platform }}</small>
                </td>
                <td>{{ formatTime(item.lastMessageAt) }}</td>
                <td>
                  <div class="im-command-actions">
                    <template v-if="!archived">
                      <button @click="navigate(item.workspaceId)">查看记录</button
                      ><button v-if="canManageAdmins" :disabled="busy" @click="adminGroup = item">
                        bot 管理员
                      </button>
                    </template>
                    <button
                      v-if="canManageHistory"
                      :disabled="busy"
                      @click="setArchived(item, !archived)"
                    >
                      {{ archived ? '取消归档' : '归档' }}
                    </button>
                    <button
                      v-if="archived && canManageHistory"
                      class="im-danger"
                      :disabled="busy"
                      @click="deleteGroup(item)"
                    >
                      永久删除
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <PaginationField
          v-if="total > 20"
          :page="page"
          :total="total"
          :page-size="20"
          :disabled="busy"
          label="群列表分页"
          @update:page="navigate(undefined, $event)"
        />
      </section>
    </template>
    <GroupAdmins
      v-if="adminGroup"
      :key="adminGroup.workspaceId"
      :workspace-id="adminGroup.workspaceId"
      :name="adminGroup.name"
      @close="adminGroup = undefined"
    />
  </div>
</template>
