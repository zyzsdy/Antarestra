<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  AntarestraLogo,
  SidebarIcon,
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  AvatarRoot,
  AvatarFallback,
} from '@antarestra/webui/components'
import {
  ArrowTopRightOnSquareIcon,
  ArrowRightStartOnRectangleIcon,
  ChevronDownIcon,
  UserCircleIcon,
} from '@antarestra/webui/icons'
import type { ClientContext } from '@antarestra/webui/client'
import type { AdminPage } from '../src/client.js'
const props = defineProps<{
  actorId: string
  displayName: string
  accountPath: string
  failure: string
  ready: boolean
  collapsed: boolean
  page: AdminPage
  items: AdminPage[]
  router: ClientContext['router']
  logout: () => Promise<void>
}>()
const emit = defineEmits<{ toggle: [] }>()
const groups = computed(() => [...new Set(props.items.map((item) => item.group))])
const groupOverrides = ref(new Map<string, boolean>())
const accountOpen = ref(false)
const accountBusy = ref(false)
const accountError = ref('')
function groupExpanded(group: string) {
  return groupOverrides.value.get(group) ?? group === props.page.group
}

function toggleGroup(group: string) {
  const overrides = new Map(groupOverrides.value)
  overrides.set(group, !groupExpanded(group))
  groupOverrides.value = overrides
}

function go(id: string) {
  void props.router.push(`/admin/${id}/`)
  if (!props.collapsed && matchMedia('(max-width: 760px)').matches) emit('toggle')
}

function returnToChat() {
  closeAccount()
  void props.router.push('/')
}

function openAccount() {
  closeAccount()
  void props.router.push(props.accountPath)
}

function closeAccount() {
  accountOpen.value = false
}

async function logout() {
  if (accountBusy.value) return
  accountBusy.value = true
  accountError.value = ''
  try {
    await props.logout()
  } catch (error) {
    accountError.value = error instanceof Error ? error.message : '退出登录失败，请重试。'
  } finally {
    accountBusy.value = false
  }
}
</script>

<template>
  <div v-if="!ready" class="access-state" role="status">
    <AntarestraLogo class="brand-mark" />
    <h1>管理控制台</h1>
    <p>{{ failure }}</p>
    <a :href="`${accountPath}?returnTo=${encodeURIComponent(router.currentRoute.value.fullPath)}`"
      >前往登录</a
    >
    <a href="/admin/">返回控制台</a>
    <a href="/">返回首页</a>
  </div>
  <div v-else class="console" :class="{ collapsed }">
    <aside class="sidebar">
      <div class="brand-row">
        <button
          v-if="collapsed"
          class="brand brand-restore"
          type="button"
          aria-label="展开管理菜单"
          title="展开管理菜单"
          @click="$emit('toggle')"
        >
          <AntarestraLogo class="brand-mark" decorative />
        </button>
        <a
          v-else
          class="brand"
          href="/admin/"
          aria-label="Antarestra 管理控制台"
          @click.prevent="router.push('/admin/')"
        >
          <AntarestraLogo class="brand-mark" decorative />
          <span class="brand-copy">Antarestra<small>管理控制台</small></span>
        </a>
        <button
          v-if="!collapsed"
          class="collapse-button"
          type="button"
          aria-label="折叠菜单"
          title="折叠菜单"
          @click="$emit('toggle')"
        >
          <SidebarIcon class="nav-icon" />
        </button>
      </div>
      <nav aria-label="后台导航">
        <CollapsibleRoot
          v-for="group in groups"
          :key="group"
          class="nav-group"
          as="section"
          :open="groupExpanded(group)"
          @update:open="toggleGroup(group)"
        >
          <CollapsibleTrigger v-if="!collapsed" class="group-title" type="button">
            <span>{{ group }}</span>
            <ChevronDownIcon class="group-chevron" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent class="group-items">
            <a
              v-for="item in items.filter((entry) => entry.group === group)"
              :key="item.id"
              :href="`/admin/${item.id}/`"
              :title="item.title"
              :aria-label="item.title"
              :aria-current="page.id === item.id ? 'page' : undefined"
              :class="['nav-item', { selected: page.id === item.id }]"
              @click.prevent="go(item.id)"
            >
              <component :is="item.icon" class="nav-icon" aria-hidden="true" />
              <span class="nav-label">{{ item.title }}</span>
            </a>
          </CollapsibleContent>
        </CollapsibleRoot>
      </nav>
      <div class="sidebar-bottom">
        <DropdownMenuRoot v-model:open="accountOpen" :modal="false">
          <DropdownMenuTrigger
            class="account-button"
            type="button"
            :aria-label="`账号菜单：${displayName}`"
            :title="collapsed ? displayName : '打开账号菜单'"
          >
            <AvatarRoot class="avatar"
              ><AvatarFallback>{{ displayName.slice(0, 1) }}</AvatarFallback></AvatarRoot
            >
            <span class="account-copy nav-label">
              <strong>{{ displayName }}</strong>
              <small>管理控制台</small>
            </span>
            <ChevronDownIcon class="account-chevron nav-label" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            :side="collapsed ? 'right' : 'top'"
            align="end"
            :side-offset="8"
            :collision-padding="12"
            class="account-menu"
            aria-label="账号菜单"
          >
            <p v-if="accountError" class="account-error" role="alert">{{ accountError }}</p>
            <DropdownMenuItem as-child @select="openAccount"
              ><a :href="accountPath" @click.prevent>
                <UserCircleIcon class="menu-icon" aria-hidden="true" />
                用户中心
              </a></DropdownMenuItem
            >
            <DropdownMenuItem as-child @select="returnToChat"
              ><a href="/" @click.prevent>
                <ArrowTopRightOnSquareIcon class="menu-icon" aria-hidden="true" />
                返回聊天
              </a></DropdownMenuItem
            >
            <DropdownMenuItem
              as="button"
              type="button"
              :disabled="accountBusy"
              @select.prevent="logout"
            >
              <ArrowRightStartOnRectangleIcon class="menu-icon" aria-hidden="true" />
              {{ accountBusy ? '正在退出…' : '退出登录' }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </div>
    </aside>
    <div class="workspace">
      <main class="content">
        <div class="page-heading">
          <p>ANTARESTRA / ADMIN</p>
          <h1>{{ page.title }}</h1>
        </div>
        <section v-if="failure" class="page-error" role="alert">
          <h2>暂时无法打开此页面</h2>
          <p>{{ failure }}</p>
          <a :href="accountPath">前往账号中心</a>
        </section>
        <component v-else :is="page.component" :key="`${actorId}/${page.id}`" />
      </main>
      <footer>Antarestra · 管理控制台</footer>
    </div>
  </div>
</template>

<style scoped>
.console {
  --side: 248px;
  --sidebar-surface: #111d32;
  --sidebar-hover: #1d2d47;
  --sidebar-border: #2a3b56;
  --z-dropdown: 220;
  min-height: 100dvh;
  background: #f4f6fa;
  color: #263047;
  font-size: 14px;
}
.console.collapsed {
  --side: 76px;
}
a {
  color: inherit;
  text-decoration: none;
}
.sidebar {
  width: var(--side);
  position: fixed;
  inset: 0 auto 0 0;
  background: #111d32;
  color: #abb9cf;
  display: flex;
  flex-direction: column;
  padding: 24px 14px 14px;
  overflow: visible;
  transition: width 0.18s;
}
.sidebar > nav {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
}
.brand-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  margin-bottom: 24px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
  color: #fff;
  padding: 4px 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font-size: 19px;
  font-weight: 650;
  text-align: left;
  white-space: nowrap;
}
.brand:hover,
.brand:active {
  background: var(--sidebar-hover);
}
.brand-mark {
  width: 36px;
  height: 30px;
  flex-shrink: 0;
}
.brand-copy {
  min-width: 0;
}
.brand-copy small {
  display: block;
  margin-top: 4px;
  color: #8295b2;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 2px;
}
.nav-group {
  margin-bottom: 12px;
}
.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 34px;
  margin: 0 0 4px;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  color: #7387a5;
  letter-spacing: 1px;
  text-align: left;
}
.group-title:hover {
  background: var(--sidebar-hover);
  color: #cbd5e5;
}
.group-chevron {
  width: 15px;
  height: 15px;
  transition: transform 0.18s ease;
}
.group-title[aria-expanded='true'] .group-chevron {
  transform: rotate(180deg);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  margin: 5px 0;
  padding: 10px 12px;
  border-radius: 7px;
  white-space: nowrap;
}
.nav-item:hover {
  background: var(--sidebar-hover);
  color: #fff;
}
.nav-item:active {
  background: #263a59;
}
.nav-item.selected {
  background: #315ed1;
  color: #fff;
}
.nav-icon {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  font-size: 20px;
}
.sidebar-bottom {
  position: relative;
  padding-top: 24px;
}
.collapse-button {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border: 1px solid var(--sidebar-border);
  border-radius: 7px;
  background: transparent;
  color: #abb9cf;
}
.collapse-button:hover,
.collapse-button:active {
  background: var(--sidebar-hover);
  color: #fff;
}
.account-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: #d9e1ed;
  text-align: left;
}
.account-button:hover,
.account-button[aria-expanded='true'] {
  border-color: var(--sidebar-border);
  background: var(--sidebar-hover);
}
.avatar {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  background: #edf1ff;
  color: #4166c7;
  border-radius: 50%;
  font-weight: 650;
}
.account-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.account-copy strong,
.account-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-copy strong {
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.account-copy small {
  color: #8295b2;
  font-size: 11px;
}
.account-chevron {
  width: 16px;
  height: 16px;
  transition: transform 0.18s ease;
}
.account-button[aria-expanded='true'] .account-chevron {
  transform: rotate(180deg);
}
.account-menu {
  z-index: var(--z-dropdown);
  width: 220px;
  max-width: calc(100vw - 24px);
  min-width: 196px;
  padding: 6px;
  border: 1px solid #dfe5ef;
  border-radius: 10px;
  background: #fff;
  color: #34415a;
  box-shadow: 0 16px 38px #07112033;
}
.account-menu a,
.account-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  padding: 9px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
}
.account-menu [data-highlighted],
.account-menu a:hover,
.account-menu button:hover,
.account-menu a:focus-visible,
.account-menu button:focus-visible {
  background: #f0f4ff;
  color: #315ed1;
}
.account-menu button:last-child {
  color: #b03b4b;
}
.account-menu button:disabled {
  color: #8d97a8;
}
.menu-icon {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
}
.account-error {
  margin: 0 4px 6px;
  padding: 8px;
  border-radius: 7px;
  background: #fff0f1;
  color: #a3293b;
  font-size: 12px;
  line-height: 1.5;
}
.collapsed .nav-label {
  display: none;
}
.collapsed .brand-row {
  justify-content: center;
}
.collapsed .brand {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  justify-content: center;
  padding: 6px;
}
.collapsed .nav-group {
  margin-bottom: 8px;
}
.collapsed .nav-item {
  justify-content: center;
  padding-inline: 10px;
}
.collapsed .account-button {
  justify-content: center;
  padding: 8px 5px;
}
.collapsed .account-menu {
  width: 208px;
}
.workspace {
  margin-left: var(--side);
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  transition: margin-left 0.18s;
}
.content {
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
  padding: 36px;
  flex: 1;
  min-width: 0;
}
.page-heading {
  margin-bottom: 28px;
}
.page-heading p {
  color: #8792a6;
  font-size: 10px;
  letter-spacing: 2px;
  margin: 0 0 10px;
}
h1 {
  font-size: 27px;
  margin: 0;
  letter-spacing: -0.5px;
}
footer {
  padding: 20px 36px;
  color: #97a1b2;
  font-size: 12px;
}
.access-state {
  max-width: 520px;
  margin: 12vh auto;
  padding: 32px;
  text-align: center;
}
.page-error {
  padding: 24px;
  border: 1px solid #e6eaf1;
  background: white;
  border-radius: 10px;
}
.page-error a {
  display: inline-block;
  padding-block: 8px;
  color: #315ed1;
}
.access-state h1 {
  margin-top: 22px;
}
.access-state p {
  margin: 24px 0;
}
.access-state a {
  display: inline-block;
  margin: 8px;
  color: #315ed1;
}
@media (max-width: 760px) {
  .console {
    --side: 220px;
  }
  .console:not(.collapsed) .workspace {
    margin-left: 76px;
  }
  .console:not(.collapsed) .sidebar {
    z-index: 120;
    box-shadow: 12px 0 40px #111d3240;
  }
  .content {
    padding: 24px 16px;
  }
  h1 {
    font-size: 23px;
  }
  footer {
    padding: 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .workspace,
  .group-chevron,
  .account-chevron {
    transition: none;
  }
}
</style>
