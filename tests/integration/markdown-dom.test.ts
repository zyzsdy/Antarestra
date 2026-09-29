// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onUnmounted, ref, shallowReactive } from 'vue'
import { MarkdownContent } from '@antarestra/markdown'
import type { CodeNode, CodeRenderer } from '@antarestra/markdown/core'
import type { PropType } from 'vue'
import {
  markdownCodeSlot,
  registerCodeRenderer,
} from '../../plugins/features/markdown-render/client/api.js'
import type { ClientContext } from '@antarestra/webui/client'
import type { EntryManifest } from '@antarestra/webui/client'
import applyMarkdown from '../../plugins/features/markdown-render/client/index.js'
import { MarkdownView, provideMarkdown } from '../../plugins/features/markdown-render/client/api.js'
import * as runtime from '../../plugins/definitions/webui/client/runtime.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function mount(source: string, extensions = shallowReactive(new Map<string, CodeRenderer>())) {
  const text = ref(source)
  const streaming = ref(true)
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () =>
      h(MarkdownContent, { source: text.value, streaming: streaming.value, extensions }),
  })
  app.mount(host)
  cleanups.push(() => app.unmount())
  return { host, text, streaming, extensions }
}

describe('Markdown DOM 与代码扩展生命周期', () => {
  it('真实客户端运行时中服务卸载回退原文，重载恢复渲染且消费者无需重挂载', async () => {
    const consumerEntry = { id: 'consumer', url: '/webui/extensions/consumer/index.js', config: {} }
    const rendererEntry = { id: 'renderer', url: '/webui/extensions/renderer/index.js', config: {} }
    let entries: EntryManifest[] = [consumerEntry, rendererEntry]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(entries))),
    )
    let consumer: ClientContext | undefined
    const stop = runtime.startExtensions(async (url) => ({
      default: url.includes('/consumer/')
        ? (ctx: ClientContext) => {
            consumer = ctx
          }
        : applyMarkdown,
    }))
    cleanups.push(stop)
    await vi.waitFor(() =>
      expect(consumer?.slot('markdown-render.service').has('default')).toBe(true),
    )
    const host = document.createElement('div')
    document.body.append(host)
    const setup = vi.fn(() => {
      provideMarkdown(consumer!)
      return () => h(MarkdownView, { source: '**已经完成**' })
    })
    const app = createApp(defineComponent({ setup }))
    app.mount(host)
    cleanups.push(() => app.unmount())
    expect(host.querySelector('strong')?.textContent).toBe('已经完成')
    entries = [consumerEntry]
    await runtime.refreshExtensions()
    await nextTick()
    expect(host.textContent).toBe('**已经完成**')
    expect(host.querySelector('strong')).toBeNull()
    entries = [consumerEntry, rendererEntry]
    await runtime.refreshExtensions()
    await nextTick()
    expect(host.querySelector('strong')?.textContent).toBe('已经完成')
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('代码复制使用委托事件，并在组件卸载时回收提示计时器', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { host } = mount('```text\n原样代码\n```\n')
    host.querySelector<HTMLButtonElement>('.md-code-copy')!.click()
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('原样代码\n')
    await vi.waitFor(() => expect(host.querySelector('.md-code-label')?.textContent).toBe('已复制'))
    expect(vi.getTimerCount()).toBe(1)
    cleanups.pop()!()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('逐次追加时保留已完成 DOM 和活动段落的文本节点', async () => {
    const { host, text, streaming } = mount('# 固定\n\n当前')
    const heading = host.querySelector('h1')!
    const paragraph = host.querySelector('p')!
    const firstText = paragraph.firstChild
    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => changes.push(...records))
    observer.observe(heading, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    for (const delta of ['正', '在', '输出', '\n\n后续\n']) {
      text.value += delta
      await nextTick()
      expect(host.querySelector('h1')).toBe(heading)
      expect(host.querySelector('p')).toBe(paragraph)
      expect(paragraph.firstChild).toBe(firstText)
    }
    streaming.value = false
    await nextTick()
    expect(changes).toHaveLength(0)
    observer.disconnect()
  })

  it.each([true, false])('按部分解析声明调用，并在闭合后保持实例：%s', async (supportsPartial) => {
    const update = vi.fn()
    const dispose = vi.fn()
    const factory = vi.fn(() => ({ update, dispose }))
    const extensions = shallowReactive(
      new Map<string, CodeRenderer>([['chart', { supportsPartial, mount: factory }]]),
    )
    const { text, streaming, host } = mount('```chart\n{', extensions)
    expect(update).toHaveBeenCalledTimes(supportsPartial ? 1 : 0)
    text.value += '}\n'
    await nextTick()
    expect(update).toHaveBeenCalledTimes(supportsPartial ? 2 : 0)
    const holder = host.querySelector('[data-md-extension]')
    text.value += '```\n'
    await nextTick()
    const calls = update.mock.calls.length
    expect(update.mock.lastCall?.[0]).toMatchObject({ source: '{}\n', closed: true })
    expect(factory).toHaveBeenCalledTimes(1)
    text.value += '\n后续\n继续'
    await nextTick()
    streaming.value = false
    await nextTick()
    expect(update).toHaveBeenCalledTimes(calls)
    expect(host.querySelector('[data-md-extension]')).toBe(holder)
    extensions.delete('chart')
    await nextTick()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(host.querySelector('pre code')?.textContent).toBe('{}\n')
  })

  it('未闭合就停止时不调用完整解析；保留可读源码', async () => {
    const factory = vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() }))
    const { host, streaming } = mount(
      '```chart\n未完成',
      new Map([['chart', { supportsPartial: false, mount: factory }]]),
    )
    streaming.value = false
    await nextTick()
    expect(factory).not.toHaveBeenCalled()
    expect(host.textContent).toContain('代码块未闭合')
    expect(host.textContent).toContain('未完成')
  })

  it('解析异常隔离到单个代码节点，后续普通文本继续显示', () => {
    const dispose = vi.fn()
    const { host } = mount(
      '```bad\n数据\n```\n\n正文\n',
      new Map([
        [
          'bad',
          {
            supportsPartial: false,
            mount: () => ({
              update: () => {
                throw new Error('无效数据')
              },
              dispose,
            }),
          },
        ],
      ]),
    )
    expect(host.textContent).toContain('扩展渲染失败')
    expect(host.textContent).toContain('正文')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('客户端注册器调用解析器、更新 Vue 组件并在所属插件卸载时回收', async () => {
    const extensions = shallowReactive(new Map<string, CodeRenderer>())
    const effects: (() => void)[] = []
    const owner = {
      contribute(slot: string, id: string, value: CodeRenderer) {
        expect(slot).toBe(markdownCodeSlot)
        if (extensions.has(id)) throw new Error('重复')
        extensions.set(id, value)
        const dispose = () => {
          if (extensions.get(id) === value) extensions.delete(id)
        }
        effects.push(dispose)
        return dispose
      },
    } as ClientContext
    const unmount = vi.fn()
    const component = defineComponent({
      props: {
        value: { type: String, required: true },
        node: { type: Object as PropType<Readonly<CodeNode>>, required: true },
      },
      setup: (props) => {
        onUnmounted(unmount)
        return () => h('strong', String(props.value))
      },
    })
    const parse = vi.fn((node: { source: string }) => node.source.toUpperCase())
    const definition = { name: 'example', supportsPartial: true, parse, component }
    const remove = registerCodeRenderer(owner, definition)
    expect(() => registerCodeRenderer(owner, definition)).toThrow('重复')
    const { host, text } = mount('```example\na', extensions)
    expect(host.querySelector('strong')?.textContent).toBe('A')
    const strong = host.querySelector('strong')
    text.value += 'b'
    await nextTick()
    expect(host.querySelector('strong')).toBe(strong)
    expect(strong?.textContent).toBe('AB')
    effects.forEach((dispose) => dispose())
    await nextTick()
    expect(unmount).toHaveBeenCalledTimes(1)
    const removeNew = registerCodeRenderer(owner, definition)
    remove()
    expect(extensions.has('example')).toBe(true)
    removeNew()
  })
})
