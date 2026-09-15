import type * as Vue from 'vue'
import type { Router, NavigationGuard } from 'vue-router'

export interface Feedback {
  notice(message: string): () => void
  toast(message: string): () => void
  modal(title: string, message: string): Promise<boolean>
  messagebox(message: string): Promise<boolean>
}
/** 扩展通过 ctx.vue.inject(feedbackKey) 获取公共交互服务。 */
export const feedbackKey = Symbol.for('antarestra.webui.feedback') as Vue.InjectionKey<Feedback>

export interface EntryManifest {
  id: string
  url: string
  config: Readonly<Record<string, unknown>>
}

export interface Page {
  path: string
  name: string
  component: Vue.Component
  beforeEnter?: NavigationGuard
}
/** 每个入口获得独立上下文；Vue 运行时由页面壳共享。 */
export interface ClientContext {
  readonly vue: typeof Vue
  readonly router: Router
  readonly config: Readonly<Record<string, unknown>>
  page(page: Page): () => void
  effect(setup: () => void | (() => void)): void
}
export type ClientPlugin = (ctx: ClientContext) => void | Promise<void>
