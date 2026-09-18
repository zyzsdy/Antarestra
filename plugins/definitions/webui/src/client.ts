import type * as Vue from 'vue'
import type { Router, NavigationGuard } from 'vue-router'
import type { SessionSnapshot } from '@antarestra/contracts'
export type { SessionSnapshot } from '@antarestra/contracts'

export interface Feedback {
  notice(message: string): () => void
  toast(message: string): () => void
  modal(title: string, message: string): Promise<boolean>
  messagebox(message: string): Promise<boolean>
}
/** 扩展通过 ctx.vue.inject(feedbackKey) 获取公共交互服务。 */
export const feedbackKey = Symbol.for('antarestra.webui.feedback') as Vue.InjectionKey<Feedback>

export interface ClientSession {
  readonly snapshot: Readonly<Vue.ShallowRef<SessionSnapshot | null>>
  read(): SessionSnapshot | null
  set(value: SessionSnapshot): void
  clear(): void
}
export const sessionKey = Symbol.for('antarestra.webui.session') as Vue.InjectionKey<ClientSession>
export const refreshExtensionsKey = Symbol.for('antarestra.webui.refresh') as Vue.InjectionKey<
  () => Promise<void>
>
export const routerKey = Symbol.for('antarestra.webui.router') as Vue.InjectionKey<Router>

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
  readonly session: ClientSession
  /** 插槽由页面宿主解释；贡献随所属扩展卸载自动回收。 */
  slot<T>(name: string): ReadonlyMap<string, T>
  contribute<T>(slot: string, id: string, value: T): () => void
  page(page: Page): () => void
  effect(setup: () => void | (() => void)): void
}
export type ClientPlugin = (ctx: ClientContext) => void | Promise<void>
