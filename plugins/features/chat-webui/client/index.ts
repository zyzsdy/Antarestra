import { defineComponent, h, reactive } from 'vue'
import type { ClientPlugin } from '@antarestra/webui/client'
import ChatPage from './ChatPage.vue'
import type { Session } from './session.js'

const apply: ClientPlugin = (ctx) => {
  const state = reactive<{ session: Session | undefined; failure: string }>({
    session: undefined,
    failure: '',
  })
  let active = true
  const controller = new AbortController()
  ctx.effect(() => () => {
    active = false
    state.session = undefined
    controller.abort()
  })
  ctx.page({
    path: '/',
    name: '聊天',
    component: defineComponent(
      () => () =>
        h(ChatPage, {
          ...state,
          signal: controller.signal,
          canAdmin: !!ctx.session.snapshot.value?.permissions.includes('admin.console.view'),
          logout: async () => {
            const response = await fetch('/api/auth/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error('退出登录失败，请重试。')
            ctx.session.clear()
            await ctx.router.push(state.session?.accountPath ?? '/auth/user/')
          },
        }),
    ),
    async beforeEnter() {
      state.session = undefined
      state.failure = ''
      try {
        const response = await fetch('/api/chat-webui/session', {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await response.json()
        if (!active) return false
        if (
          response.status === 401 &&
          typeof data.loginPath === 'string' &&
          /^\/auth\/user\/(?:[a-z0-9-]+\/)?$/.test(data.loginPath)
        )
          return { path: data.loginPath, query: { returnTo: '/' } }
        if (!response.ok) {
          state.failure = data.error || '暂时无法验证访问权限'
          return true
        }
        if (!data.actorId || !data.workspaceId) throw new Error('身份信息不完整')
        state.session = data as Session
      } catch {
        if (!active) return false
        state.failure = '无法验证访问权限，请稍后重试。'
      }
      return true
    },
  })
}
export default apply
