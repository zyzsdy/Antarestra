import type * as Vue from 'vue'

export interface Page {
  path: string
  name: string
  component: Vue.Component
}
/** 每个入口获得独立上下文；Vue 运行时由页面壳共享。 */
export interface ClientContext {
  readonly vue: typeof Vue
  readonly config: Readonly<Record<string, unknown>>
  page(page: Page): () => void
  effect(setup: () => void | (() => void)): void
}
export type ClientPlugin = (ctx: ClientContext) => void | Promise<void>
