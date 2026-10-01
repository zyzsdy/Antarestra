<script setup lang="ts">
import { ref } from 'vue'
import type { Conversation } from '@antarestra/contracts'
import type { Session } from './session.js'
import {
  AntarestraLogo,
  AvatarRoot,
  AvatarFallback,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@antarestra/webui/components'
import {
  PlusIcon,
  ArrowLeftIcon,
  EllipsisVerticalIcon,
  ArchiveBoxIcon,
  PencilSquareIcon,
  ArrowTopRightOnSquareIcon,
  ArrowRightStartOnRectangleIcon,
  ChevronUpIcon,
  UserCircleIcon,
} from '@antarestra/webui/icons'
const props = defineProps<{
  session: Session
  canAdmin: boolean
  logout: () => Promise<void>
  items: Conversation[]
  currentId: string
  archived: boolean
  loading: boolean
  more: boolean
  error: string
}>()
defineEmits<{
  select: [id: string]
  new: []
  toggle: [archived: boolean]
  more: []
  refresh: []
  rename: [item: Conversation]
  archive: [item: Conversation]
}>()
const loggingOut = ref(false)
const logoutError = ref('')
async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  logoutError.value = ''
  try {
    await props.logout()
  } catch (cause) {
    logoutError.value = cause instanceof Error ? cause.message : '退出登录失败，请重试。'
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <a class="chat-brand" href="/"><AntarestraLogo decorative />Antarestra</a>
  <button class="chat-new" @click="$emit('new')"><PlusIcon class="ui-icon" />新对话</button>
  <div class="chat-history-heading">
    <h2>{{ archived ? '已归档对话' : '对话' }}</h2>
    <button
      v-if="archived"
      class="chat-icon-button"
      aria-label="返回对话"
      title="返回对话"
      @click="$emit('toggle', false)"
    >
      <ArrowLeftIcon class="ui-icon" />
    </button>
  </div>
  <nav class="chat-history" aria-label="对话历史">
    <div
      v-for="item in items"
      :key="item.id"
      class="chat-history-row"
      :class="{ selected: item.id === currentId }"
    >
      <button
        class="chat-history-title"
        :aria-current="item.id === currentId ? 'page' : undefined"
        :title="item.title || '新对话'"
        @click="$emit('select', item.id)"
      >
        <span class="chat-history-status">
          <span
            v-if="item.activeRunId"
            class="chat-history-spinner"
            role="status"
            aria-label="正在生成"
          />
        </span>
        <span class="chat-history-label">{{ item.title || '新对话' }}</span>
      </button>
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="chat-icon-button chat-history-actions"
          :aria-label="`${item.title || '新对话'}的操作`"
          ><EllipsisVerticalIcon class="ui-icon"
        /></DropdownMenuTrigger>
        <DropdownMenuPortal
          ><DropdownMenuContent class="chat-popover" :side-offset="5" :collision-padding="12">
            <DropdownMenuItem class="chat-menu-item" @select="$emit('rename', item)"
              ><PencilSquareIcon class="ui-icon" />重命名</DropdownMenuItem
            >
            <DropdownMenuItem
              class="chat-menu-item"
              :disabled="!!item.activeRunId"
              @select="$emit('archive', item)"
              ><ArchiveBoxIcon class="ui-icon" />{{
                item.archivedAt ? '取消归档' : '归档'
              }}</DropdownMenuItem
            >
            <small v-if="item.activeRunId" class="chat-menu-note">生成结束后可归档</small>
          </DropdownMenuContent></DropdownMenuPortal
        >
      </DropdownMenuRoot>
    </div>
    <p v-if="!items.length && !loading && !error" class="chat-muted">
      {{ archived ? '没有已归档的对话' : '开始一段新对话吧。' }}
    </p>
    <p v-if="loading" class="chat-muted" role="status">正在加载…</p>
    <p v-if="error" class="chat-inline-error" role="alert">
      {{ error }}<button class="chat-text-button" @click="$emit('refresh')">重试</button>
    </p>
    <button v-if="more" class="chat-text-button" :disabled="loading" @click="$emit('more')">
      加载更多
    </button>
  </nav>
  <DropdownMenuRoot>
    <DropdownMenuTrigger class="chat-profile" aria-label="用户菜单"
      ><AvatarRoot class="chat-avatar"
        ><AvatarFallback>{{ session.displayName.slice(0, 1) }}</AvatarFallback></AvatarRoot
      ><span>{{ session.displayName }}</span
      ><ChevronUpIcon class="ui-icon"
    /></DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="chat-popover chat-account-menu"
        side="top"
        align="start"
        :side-offset="8"
        :collision-padding="12"
      >
        <DropdownMenuItem class="chat-menu-item" @select="$emit('toggle', true)"
          ><ArchiveBoxIcon class="ui-icon" />已归档对话</DropdownMenuItem
        >
        <DropdownMenuItem class="chat-menu-item" as-child
          ><a :href="session.accountPath"
            ><UserCircleIcon class="ui-icon" />个人中心</a
          ></DropdownMenuItem
        >
        <DropdownMenuItem v-if="canAdmin" class="chat-menu-item" as-child
          ><a href="/admin/"
            ><ArrowTopRightOnSquareIcon class="ui-icon" />管理控制台</a
          ></DropdownMenuItem
        >
        <DropdownMenuItem class="chat-menu-item" :disabled="loggingOut" @select.prevent="logout"
          ><ArrowRightStartOnRectangleIcon class="ui-icon" />{{
            loggingOut ? '正在退出…' : '退出登录'
          }}</DropdownMenuItem
        >
        <p v-if="logoutError" class="chat-inline-error" role="alert">{{ logoutError }}</p>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
