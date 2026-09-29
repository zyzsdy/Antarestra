// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onUnmounted, ref, shallowReactive } from 'vue'
import { MarkdownContent, sanitizeHtml } from '@antarestra/markdown'
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
  it('默认展示基础 HTML、斜体、内联样式和受限链接图片', () => {
    const { host } = mount(
      '<div><u>下划线</u> H<sub>2</sub>O x<sup>2</sup> <small>小字</small> <mark>重点</mark> <kbd>Ctrl</kbd> <ruby>字<rp>(</rp><rt>zi</rt><rp>)</rp></ruby> <span style="color: red; background-color: yellow; font-style: italic">彩色</span> <i>斜体</i><a href="https://example.com" target="named">链接</a><img src="/test.png" alt="示例"></div>\n\n*中文斜体*',
    )
    for (const tag of [
      'u',
      'sub',
      'sup',
      'small',
      'mark',
      'kbd',
      'ruby',
      'rp',
      'rt',
      'span',
      'i',
      'em',
      'a',
      'img',
    ]) {
      expect(host.querySelector(tag)).not.toBeNull()
    }
    expect(host.querySelector('span')?.style.color).toBe('red')
    expect(host.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/test.png')
  })

  it('包含空行的 HTML 容器逐字追加后仍包裹完整内容', async () => {
    const source =
      '<details>\n<summary>详情</summary>\n\n正文 *强调*\n\n<div>末尾</div>\n</details>\n\n后续段落'
    const { host, text, streaming } = mount('')
    for (let length = 1; length <= source.length; length++) {
      text.value = source.slice(0, length)
      await nextTick()
    }
    streaming.value = false
    await nextTick()
    expect(host.querySelector('details summary')?.textContent).toBe('详情')
    expect(host.querySelector('details em')?.textContent).toBe('强调')
    expect(host.querySelector('details div')?.textContent).toBe('末尾')
    expect(host.querySelector('details')?.textContent).not.toContain('后续段落')
  })

  it('清除脚本、样式表、事件、危险 URL 和请求资源或定位覆盖的内联样式', () => {
    const { host } = mount(
      '<div><style>body { color: red }</style><script>window.bad = true</script><iframe src="https://example.com"></iframe><img src="javascript:evil()" onerror="evil()" srcset="https://example.com/x 2x"><a href="jav&#x61;script:evil()" onclick="evil()">危险链接</a><span style="color: red !important; position: fixed; z-index: 9999; background-image: url(https://example.com/x); --secret: url(https://example.com/y)">正文</span></div>',
    )
    expect(host.querySelector('script, style, iframe, [onclick], [onerror], [srcset]')).toBeNull()
    expect(host.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false)
    expect(host.querySelector('span')?.getAttribute('style')).toBe('color: red;')
    expect(host.textContent).not.toContain('window.bad')
    expect(host.textContent).not.toContain('body {')
  })

  it.each(['data:text/html,evil', 'vbscript:evil()', 'file:///C:/secret', 'javascript:evil()'])(
    '拒绝非允许的链接协议：%s',
    (href) => {
      const container = document.createElement('div')
      container.innerHTML = sanitizeHtml(`<a href="${href}">链接</a><img src="${href}">`)
      expect(container.querySelector('a')?.hasAttribute('href')).toBe(false)
      expect(container.querySelector('img')?.hasAttribute('src')).toBe(false)
    },
  )

  it('原始 HTML 不能冒充代码扩展占位，更新时也不冻结其内容', async () => {
    const update = vi.fn()
    const { host, text } = mount(
      '<div data-md-extension="0">原文</div>\n\n```chart\n数据\n```\n',
      new Map([['chart', { supportsPartial: true, mount: () => ({ update, dispose() {} }) }]]),
    )
    expect(update).toHaveBeenCalledTimes(1)
    expect(host.querySelectorAll('[data-md-extension]')).toHaveLength(1)
    text.value = '<div data-md-extension="0">新文</div>'
    await nextTick()
    expect(host.textContent).toBe('新文')
  })

  it('HTML 清洗后仍保留公式布局和复制图标', () => {
    const { host } = mount('$$\\frac{a^2}{\\sqrt{b}}$$\n\n```js\nconst x = 1\n```\n')
    expect(host.querySelector('.katex math')).not.toBeNull()
    expect(host.querySelector('.katex [style*="height"]')).not.toBeNull()
    expect(host.querySelector('.md-code-copy svg')).not.toBeNull()
  })

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
