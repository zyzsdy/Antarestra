<script setup lang="ts">
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
  EllipsisHorizontalIcon,
  ArchiveBoxIcon,
  PencilSquareIcon,
  ArrowTopRightOnSquareIcon,
} from '@antarestra/webui/icons'
defineProps<{
  session: Session
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
  toggle: []
  more: []
  refresh: []
  rename: [item: Conversation]
  archive: [item: Conversation]
}>()
</script>

<template>
  <a class="chat-brand" href="/"><AntarestraLogo decorative />Antarestra</a>
  <button class="chat-new" @click="$emit('new')"><PlusIcon class="ui-icon" />新对话</button>
  <div class="chat-history-heading">
    <h2>{{ archived ? '已归档对话' : '你的对话' }}</h2>
    <button class="chat-text-button" :disabled="loading" @click="$emit('refresh')">刷新</button>
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
        {{ item.title || '新对话' }}
      </button>
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="chat-icon-button chat-history-actions"
          :aria-label="`${item.title || '新对话'}的操作`"
          ><EllipsisHorizontalIcon class="ui-icon"
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
  <button class="chat-archive-link" @click="$emit('toggle')">
    <ArchiveBoxIcon class="ui-icon" />{{ archived ? '返回历史对话' : '已归档对话' }}
  </button>
  <a class="chat-profile" :href="session.accountPath"
    ><AvatarRoot class="chat-avatar"
      ><AvatarFallback>{{ session.displayName.slice(0, 1) }}</AvatarFallback></AvatarRoot
    ><span>{{ session.displayName }}</span
    ><ArrowTopRightOnSquareIcon class="ui-icon"
  /></a>
</template>
