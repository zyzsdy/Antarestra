<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '@antarestra/webui/api'
import { PaginationField } from '@antarestra/webui/components'
import { ArrowPathIcon } from '@antarestra/webui/icons'
import type { GroupSummary } from '@antarestra/im'
import GroupHistory from './GroupHistory.vue'
import { formatTime } from './history-format'
import './style.css'

const { api, run, busy, message, router } = useApi()
const groups = ref<GroupSummary[]>([])
const total = ref(0)
const loaded = ref(false)
const group = computed(() => String(router.currentRoute.value.query.group ?? ''))
const page = computed(() => Math.max(1, Number(router.currentRoute.value.query.page) || 1))
const selected = computed(() => groups.value.find((item) => item.workspaceId === group.value))
async function load() {
  const result = await api<{ groups: GroupSummary[]; total: number }>(
    `/im/groups?offset=${(page.value - 1) * 20}`,
  )
  groups.value = result.groups
  total.value = result.total
  loaded.value = true
}
function navigate(workspaceId?: string, nextPage = page.value) {
  void router.push({
    query: { page: String(nextPage), ...(workspaceId ? { group: workspaceId } : {}) },
  })
}
watch(
  page,
  () => {
    void run(load)
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
        <p class="im-hint">按群查看已归档的消息，以及每次 AI 处理的输入、返回和投递状态。</p>
        <button :disabled="busy" title="刷新群列表" aria-label="刷新群列表" @click="run(load)">
          <ArrowPathIcon class="ui-icon" />
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
          暂无群聊记录。机器人收到准入规则允许的群消息后会显示在这里。
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
                  <strong>{{ item.name }}</strong
                  ><small>群 {{ item.chatId }}</small>
                </td>
                <td>
                  {{ item.connectionId || '已卸载的接入' }}<small>{{ item.platform }}</small>
                </td>
                <td>{{ formatTime(item.lastMessageAt) }}</td>
                <td><button @click="navigate(item.workspaceId)">查看记录</button></td>
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
  </div>
</template>
