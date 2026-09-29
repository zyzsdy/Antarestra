import { computed, createVNode, inject, provide, render } from 'vue'
import type { Component, ComputedRef, InjectionKey } from 'vue'
import type { ClientContext } from '@antarestra/webui/client'
import type { CodeNode, CodeRenderer } from '@antarestra/markdown/core'
export { default as MarkdownView } from './MarkdownView.vue'
export type { CodeNode } from '@antarestra/markdown/core'

export const markdownServiceSlot = 'markdown-render.service'
export const markdownCodeSlot = 'markdown-render.code'
export interface MarkdownRenderService {
  readonly component: Component<{ source: string; streaming?: boolean }>
}
const serviceKey = Symbol.for('antarestra.markdown-render') as InjectionKey<
  ComputedRef<MarkdownRenderService | undefined>
>

/** 在页面包装组件的 setup 内调用；响应渲染插件的加载、卸载与重新加载。 */
export function provideMarkdown(ctx: ClientContext) {
  const services = ctx.slot<MarkdownRenderService>(markdownServiceSlot)
  provide(
    serviceKey,
    computed(() => services.get('default')),
  )
}
export function useMarkdown() {
  return inject(
    serviceKey,
    computed(() => undefined),
  )
}

export interface CodeExtension<Value> {
  /** 围栏 info 的第一个单词，大小写敏感。 */
  name: string
  supportsPartial: boolean
  /** 同步解析当前代码节点；已闭合且不变的节点不会再次解析。 */
  parse(node: Readonly<CodeNode>): Value
  /** Vue SFC 接收 value 和 node；副作用使用 Vue 卸载钩子回收。 */
  component: Component<{ value: Value; node: Readonly<CodeNode> }>
}

/** 注册与 owner 上下文绑定；可在渲染服务加载之前注册。 */
export function registerCodeRenderer<Value>(owner: ClientContext, extension: CodeExtension<Value>) {
  if (!extension.name || /\s|[`~]/.test(extension.name)) throw new Error('代码扩展名称无效')
  const renderer: CodeRenderer = {
    supportsPartial: extension.supportsPartial,
    mount(host) {
      return {
        update(node) {
          const value = extension.parse(Object.freeze({ ...node }))
          render(createVNode(extension.component, { value, node }), host)
        },
        dispose: () => render(null, host),
      }
    },
  }
  return owner.contribute(markdownCodeSlot, extension.name, renderer)
}

/** 仅预留：未来主解析器生成 AST，再把节点交给所属扩展；当前没有注册入口。 */
export interface SyntaxExtensionDeclaration {
  readonly kind: 'syntax'
  readonly name: string
  readonly syntax: string
  readonly nodeType: string
}
