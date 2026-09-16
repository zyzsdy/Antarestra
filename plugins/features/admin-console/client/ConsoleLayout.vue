<script setup lang="ts">
import { computed } from 'vue'
import type { ClientContext } from '@antarestra/webui/client'
import type { AdminPage } from '../src/client.js'
const props = defineProps<{
  displayName: string
  accountPath: string
  failure: string
  ready: boolean
  collapsed: boolean
  page: AdminPage
  items: AdminPage[]
  router: ClientContext['router']
}>()
defineEmits<{ toggle: [] }>()
const groups = computed(() => [...new Set(props.items.map((item) => item.group))])
function go(id: string) {
  void props.router.push(`/admin/${id}/`)
}
</script>

<template>
  <div v-if="!ready" class="access-state" role="status">
    <span class="brand-mark">A</span>
    <h1>管理控制台</h1>
    <p>{{ failure || '正在验证访问权限…' }}</p>
    <a href="/auth/user/?returnTo=/admin/">前往登录</a>
    <a href="/admin/">返回控制台</a>
    <a href="/">返回首页</a>
  </div>
  <div v-else class="console" :class="{ collapsed }">
    <aside class="sidebar">
      <a class="brand" href="/admin/" aria-label="Antarestra 管理控制台"
        ><span class="brand-mark">A</span
        ><span class="nav-label">Antarestra<small>管理控制台</small></span></a
      >
      <nav aria-label="后台导航">
        <section v-for="group in groups" :key="group" class="nav-group">
          <h2 class="group-title">{{ group }}</h2>
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
            <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span
            ><span class="nav-label">{{ item.title }}</span>
          </a>
        </section>
      </nav>
      <div class="sidebar-bottom">
        <a class="nav-item" href="/" title="返回聊天" aria-label="返回聊天"
          ><span class="nav-icon" aria-hidden="true">↗</span
          ><span class="nav-label">返回聊天</span></a
        >
        <button
          class="collapse-button"
          :aria-expanded="!collapsed"
          :aria-label="collapsed ? '展开菜单' : '折叠菜单'"
          :title="collapsed ? '展开菜单' : '折叠菜单'"
          @click="$emit('toggle')"
        >
          <span class="nav-icon" aria-hidden="true">{{ collapsed ? '»' : '«' }}</span
          ><span class="nav-label">折叠菜单</span>
        </button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <span
          >管理控制台 <span class="breadcrumb">/ {{ page.group }}</span></span
        ><a :href="accountPath" class="account"
          ><span class="avatar">{{ displayName.slice(0, 1) }}</span
          ><span>{{ displayName }}</span></a
        >
      </header>
      <main class="content">
        <div class="page-heading">
          <p>ANTARESTRA / ADMIN</p>
          <h1>{{ page.title }}</h1>
        </div>
        <component :is="page.component" :key="page.id" />
      </main>
      <footer>Antarestra · 管理控制台</footer>
    </div>
  </div>
</template>

<style scoped>
.console {
  --side: 248px;
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
  overflow-y: auto;
  transition: width 0.18s;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #fff;
  padding: 0 8px 32px;
  font-size: 19px;
  font-weight: 650;
  white-space: nowrap;
}
.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 36px;
  flex-shrink: 0;
  background: #5278ef;
  color: white;
  border-radius: 9px;
  font-size: 21px;
  font-weight: 700;
}
.brand small {
  display: block;
  margin-top: 4px;
  color: #8295b2;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 2px;
}
.nav-group {
  margin-bottom: 24px;
}
.group-title {
  margin: 0 12px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #7387a5;
  letter-spacing: 1px;
}
.nav-item,
.collapse-button {
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
.nav-item:hover,
.collapse-button:hover {
  background: #1d2d47;
  color: #fff;
}
.nav-item.selected {
  background: #315ed1;
  color: #fff;
}
.nav-icon {
  display: inline-grid;
  place-items: center;
  width: 20px;
  flex-shrink: 0;
  font-size: 20px;
}
.sidebar-bottom {
  margin-top: auto;
  padding-top: 24px;
}
.collapse-button {
  border: 1px solid #2a3b56;
  background: transparent;
  color: #abb9cf;
  text-align: left;
}
.collapsed .nav-label {
  display: none;
}
.collapsed .group-title {
  font-size: 0;
  margin: 12px 6px;
  border-top: 1px solid #2a3b56;
}
.collapsed .brand {
  padding-inline: 8px;
}
.workspace {
  margin-left: var(--side);
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  transition: margin-left 0.18s;
}
.topbar {
  height: 72px;
  padding: 0 36px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e6eaf1;
  gap: 16px;
}
.breadcrumb {
  margin-left: 12px;
  color: #8792a6;
}
.account {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  background: #edf1ff;
  color: #4166c7;
  border-radius: 50%;
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
    --side: 200px;
  }
  .console:not(.collapsed) .workspace {
    margin-left: 76px;
  }
  .console:not(.collapsed) .sidebar {
    z-index: 2;
    box-shadow: 12px 0 40px #111d3240;
  }
  .topbar {
    padding: 0 16px;
    height: 60px;
  }
  .breadcrumb,
  .account > span:last-child {
    display: none;
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
  .workspace {
    transition: none;
  }
}
</style>
