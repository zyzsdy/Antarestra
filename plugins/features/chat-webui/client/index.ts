import { feedbackKey } from '@antarestra/webui/client'
import type { ClientPlugin } from '@antarestra/webui/client'
import { style } from './style.js'
interface Session {
  actorId: string
  workspaceId: string
  displayName: string
  roles: string[]
  accountPath: string
}
const apply: ClientPlugin = (ctx) => {
  const { h, ref, inject, defineComponent, onMounted, onUnmounted } = ctx.vue
  let session: Session | undefined
  let failure = ''
  let active = true
  const controller = new AbortController()
  ctx.effect(() => () => {
    active = false
    session = undefined
    controller.abort()
  })
  const component = defineComponent({
    setup() {
      const feedback = inject(feedbackKey)!
      const sidebar = ref(false)
      const identity = session
      const check = async () => {
        try {
          const response = await fetch('/api/chat-webui/session', {
            cache: 'no-store',
            signal: controller.signal,
          })
          if (!response.ok) {
            location.reload()
            return
          }
          const fresh = (await response.json()) as Session
          if (fresh.actorId !== identity?.actorId || fresh.workspaceId !== identity?.workspaceId)
            location.reload()
        } catch {
          /* 下一次聚焦时重新验证；页面没有聊天数据或可执行请求。 */
        }
      }
      onMounted(() => window.addEventListener('focus', check))
      onUnmounted(() => window.removeEventListener('focus', check))
      return () =>
        !identity
          ? h('main', { class: 'chat-error', role: 'alert' }, [
              h('h1', '暂时无法进入聊天'),
              h('p', failure),
              h('a', { href: '/' }, '重试'),
            ])
          : h('div', { class: ['chat-app', sidebar.value && 'sidebar-open'] }, [
              h('style', style),
              sidebar.value &&
                h('button', {
                  class: 'chat-backdrop',
                  'aria-label': '关闭侧栏',
                  onClick: () => (sidebar.value = false),
                }),
              h('aside', { class: 'chat-sidebar', 'aria-label': '聊天记录' }, [
                h('a', { class: 'chat-brand', href: '/' }, [
                  h('span', { class: 'chat-logo' }, '✳'),
                  'Antarestra',
                ]),
                h(
                  'button',
                  {
                    class: 'chat-new',
                    onClick: () => feedback.toast('聊天功能即将开放，敬请期待。'),
                  },
                  ['＋', h('span', '新对话')],
                ),
                h('div', { class: 'chat-history' }, [
                  h('h2', '你的对话'),
                  h('p', '还没有聊天记录'),
                  h('small', '开始一段对话，让想法在这里延续。'),
                ]),
                h('div', { class: 'chat-workspace' }, [
                  h('span', '◈'),
                  h('div', [h('strong', '个人工作空间'), h('small', '当前空间暂无对话')]),
                ]),
                h('a', { class: 'chat-profile', href: identity.accountPath }, [
                  h('span', { class: 'chat-avatar' }, identity.displayName.slice(0, 1)),
                  h('div', [
                    h('strong', identity.displayName),
                    h('small', identity.roles.includes('admin') ? '管理员' : '已登录用户'),
                  ]),
                  h('span', '↗'),
                ]),
              ]),
              h('main', { class: 'chat-main' }, [
                h('header', { class: 'chat-header' }, [
                  h('div', [
                    h(
                      'button',
                      {
                        class: 'chat-menu',
                        'aria-label': '打开聊天记录',
                        'aria-expanded': sidebar.value,
                        onClick: () => (sidebar.value = !sidebar.value),
                      },
                      '☰',
                    ),
                    h('strong', '新对话'),
                  ]),
                  h('span', { class: 'chat-preview' }, '预览版'),
                ]),
                h('section', { class: 'chat-welcome' }, [
                  h('div', { class: 'chat-spark' }, '✳'),
                  h('p', { class: 'chat-eyebrow' }, '让灵感，从一次对话开始'),
                  h('h1', '今天，有什么新想法？'),
                  h(
                    'p',
                    { class: 'chat-subtitle' },
                    '整理思路、探索问题，或是聊聊你的下一个计划。',
                  ),
                  h(
                    'div',
                    { class: 'chat-suggestions' },
                    [
                      ['✎', '写下一个想法', '把零散的灵感整理成文字'],
                      ['◎', '探索一个问题', '从不同角度看待新的可能'],
                      ['⌘', '规划下一步', '让想法成为清晰的行动'],
                    ].map(([icon, title, detail]) =>
                      h(
                        'button',
                        {
                          onClick: () =>
                            feedback.messagebox('当前为界面预览，暂未接入模型和聊天记录功能。'),
                        },
                        [
                          h('span', { class: 'suggestion-icon' }, icon),
                          h('strong', title),
                          h('small', detail),
                        ],
                      ),
                    ),
                  ),
                ]),
                h('footer', { class: 'chat-composer-area' }, [
                  h('div', { class: 'chat-composer' }, [
                    h('textarea', {
                      disabled: true,
                      rows: 2,
                      placeholder: '聊天功能即将开放…',
                      'aria-label': '消息输入框',
                    }),
                    h('div', [
                      h('span', '当前为界面预览'),
                      h('button', { disabled: true, 'aria-label': '发送消息' }, '↑'),
                    ]),
                  ]),
                  h('p', '对话将保存在当前工作空间。'),
                ]),
              ]),
            ])
    },
  })
  ctx.page({
    path: '/',
    name: '聊天',
    component,
    async beforeEnter() {
      session = undefined
      failure = ''
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
          failure = data.error || '暂时无法验证访问权限'
          return true
        }
        if (!data.actorId || !data.workspaceId) throw new Error('身份信息不完整')
        session = data as Session
      } catch {
        if (!active) return false
        failure = '无法验证访问权限，请稍后重试。'
      }
      return true
    },
  })
}
export default apply
