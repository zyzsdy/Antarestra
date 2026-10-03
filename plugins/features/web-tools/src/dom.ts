import type { Page, ElementHandle } from '@antarestra/puppeteer'
import { randomUUID } from 'node:crypto'
import { WebError } from './common.js'

type Frame = ReturnType<Page['frames']>[number]
export interface Entry {
  ref: string
  parent: string | null
  role: string
  name: string
  text: string
  hidden: boolean
  main: boolean
  interactive: boolean
  state: string
  href: string
}
interface Registry {
  document: Document
  id: string
  next: number
  nodes: Map<string, Element>
  ids: WeakMap<Element, string>
  signatures: Map<string, string>
  version: number
}
export interface Snapshot {
  id: string
  entries: Entry[]
  frames: Map<string, Frame>
  warnings: string[]
}

/** 此函数只在受控页面环境中执行，不接受模型提供的代码。 */
function collect(key: string, nonce: string): Entry[] {
  const root = globalThis as unknown as Record<string, Registry>
  if (!root[key] || root[key].document !== document) {
    const registry: Registry = {
      document,
      id: nonce,
      next: 0,
      nodes: new Map(),
      ids: new WeakMap(),
      signatures: new Map(),
      version: 0,
    }
    root[key] = registry
    new MutationObserver(() => registry.version++).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      characterData: true,
      childList: true,
    })
  }
  const registry = root[key]!
  const entries: Entry[] = []
  // 使用对象方法，避免 tsx 为局部函数注入浏览器环境中不存在的 __name 辅助函数。
  const { id, clean, visit } = {
    id(element: Element) {
      let value = registry.ids.get(element)
      if (!value) {
        value = `${registry.id}:e${++registry.next}`
        registry.ids.set(element, value)
        registry.nodes.set(value, element)
      }
      return value
    },
    clean(value: string | null | undefined) {
      return (value ?? '').replace(/\s+/g, ' ').trim()
    },
    visit(element: Element, parent: string | null, main: boolean, hidden: boolean) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(element.tagName)) return
      const style = getComputedStyle(element)
      hidden ||=
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        element.getAttribute('aria-hidden') === 'true' ||
        element.hasAttribute('hidden')
      main ||= element.matches('main,article,[role="main"]')
      const tag = element.tagName.toLowerCase()
      const native: Record<string, string> = {
        a: 'link',
        button: 'button',
        input: 'textbox',
        textarea: 'textbox',
        select: 'combobox',
        h1: 'heading',
        h2: 'heading',
        h3: 'heading',
        h4: 'heading',
        h5: 'heading',
        h6: 'heading',
        table: 'table',
        tr: 'row',
        th: 'columnheader',
        td: 'cell',
        li: 'listitem',
        ul: 'list',
        ol: 'list',
        main: 'main',
        article: 'article',
        nav: 'navigation',
        dialog: 'dialog',
        img: 'img',
        summary: 'button',
      }
      let role = element.getAttribute('role') || native[tag] || ''
      if (element instanceof HTMLInputElement)
        role = ['checkbox', 'radio'].includes(element.type)
          ? element.type
          : ['button', 'submit', 'reset'].includes(element.type)
            ? 'button'
            : 'textbox'
      const interactive =
        [
          'link',
          'button',
          'textbox',
          'combobox',
          'checkbox',
          'radio',
          'slider',
          'tab',
          'menuitem',
          'switch',
        ].includes(role) ||
        element.hasAttribute('contenteditable') ||
        (element as HTMLElement).tabIndex >= 0
      const direct = clean(
        Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(' '),
      )
      const labels = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((label) => document.getElementById(label)?.textContent ?? '')
        .join(' ')
      const formLabels =
        'labels' in element
          ? Array.from((element as HTMLInputElement).labels ?? [])
              .map((label) => label.textContent)
              .join(' ')
          : ''
      const name = clean(
        element.getAttribute('aria-label') ||
          labels ||
          formLabels ||
          element.getAttribute('alt') ||
          element.getAttribute('title') ||
          (interactive || role === 'heading' ? element.textContent : '') ||
          element.getAttribute('placeholder'),
      ).slice(0, 1000)
      const state: string[] = []
      for (const attr of ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled'])
        if (element.hasAttribute(attr)) state.push(`${attr.slice(5)}=${element.getAttribute(attr)}`)
      if ('disabled' in element && element.disabled) state.push('disabled=true')
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type))
        state.push(`checked=${element.checked}`)
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        state.push(
          element instanceof HTMLInputElement && element.type === 'password'
            ? 'value=[密码已隐藏]'
            : `value=${element.value.slice(0, 1000)}`,
        )
      const ref = id(element)
      if (interactive) registry.signatures.set(ref, element.outerHTML)
      if (role || direct || interactive) {
        entries.push({
          ref,
          parent,
          role: role || 'text',
          name,
          text: direct,
          hidden,
          main,
          interactive,
          state: state.join(' '),
          href: element instanceof HTMLAnchorElement ? element.href : '',
        })
        parent = ref
      }
      for (const child of element.children) visit(child, parent, main, hidden)
      if (element.shadowRoot)
        for (const child of element.shadowRoot.children) visit(child, parent, main, hidden)
    },
  }
  visit(document.body ?? document.documentElement, null, false, false)
  for (const [ref, element] of registry.nodes) if (!element.isConnected) registry.nodes.delete(ref)
  return entries
}
export async function readDom(page: Page, key: string): Promise<Snapshot> {
  const result: Snapshot = { id: randomUUID(), entries: [], frames: new Map(), warnings: [] }
  for (const frame of page.frames()) {
    try {
      const entries = await frame.evaluate(collect, key, randomUUID())
      for (const entry of entries) result.frames.set(entry.ref, frame)
      result.entries.push(...entries)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      if (frame === page.mainFrame())
        throw new WebError('page_read_failed', `主页面正文读取失败：${reason}`)
      result.warnings.push(`子框架无法读取，搜索不包含该区域：${reason}`)
    }
  }
  // DOM 已提供的大多数名称无需额外协议往返；浏览器负责补足复杂可访问名称。
  for (const entry of result.entries.filter(
    (entry) => entry.interactive && !entry.hidden && !entry.name,
  )) {
    try {
      const element = await target(result, entry.ref, key)
      try {
        const accessible = await page.accessibility.snapshot({
          root: element,
          interestingOnly: false,
        })
        if (accessible) {
          entry.name = accessible.name ?? ''
          entry.role = accessible.role
        }
      } finally {
        await element.dispose()
      }
    } catch {
      result.warnings.push('部分控件的可访问名称不可读取，已保留 DOM 描述')
    }
  }
  return result
}
export async function target(snapshot: Snapshot | undefined, ref: string, key: string) {
  const frame = snapshot?.frames.get(ref)
  const old = snapshot?.entries.find((entry) => entry.ref === ref)
  if (!frame || !old || frame.detached)
    throw new WebError('stale_element', '元素引用已过期，请使用新快照')
  const handle = await frame.evaluateHandle(
    (key, ref) => {
      const registry = (globalThis as unknown as Record<string, Registry>)[key]
      const element = registry?.nodes.get(ref)
      const signature = registry?.signatures.get(ref)
      return registry?.document === document &&
        element?.isConnected &&
        (!signature || signature === element.outerHTML)
        ? element
        : null
    },
    key,
    ref,
  )
  const element = handle.asElement()
  if (!element) {
    await handle.dispose()
    throw new WebError('stale_element', '元素已被替换，请使用新快照')
  }
  return element as ElementHandle<Element>
}
export function render(snapshot: Snapshot, view: string, node?: string) {
  const selected = new Set<string>()
  if (node && !snapshot.entries.some((entry) => entry.ref === node))
    throw new WebError('stale_element', '读取节点不存在')
  const hasMain = snapshot.entries.some((entry) => entry.main)
  const depths = new Map<string, number>()
  for (const entry of snapshot.entries)
    depths.set(entry.ref, entry.parent ? Math.min(8, (depths.get(entry.parent) ?? 0) + 1) : 0)
  return snapshot.entries
    .filter((entry) => {
      if (node) {
        if (entry.ref === node || (entry.parent && selected.has(entry.parent)))
          selected.add(entry.ref)
        if (!selected.has(entry.ref)) return false
      }
      if (entry.hidden) return view === 'full'
      if (view === 'interactive') return entry.interactive || entry.role === 'dialog'
      if (view === 'main') return !hasMain || entry.main
      if (view === 'full') return true
      return (
        !hasMain ||
        entry.main ||
        entry.interactive ||
        entry.role === 'dialog' ||
        entry.role === 'heading'
      )
    })
    .map(
      (entry) =>
        `${'  '.repeat(depths.get(entry.ref) ?? 0)}${entry.role} [${entry.ref}] ${entry.name}${entry.text && entry.text !== entry.name ? ' ' + entry.text : ''}${entry.state ? ' (' + entry.state + ')' : ''}${entry.href ? ' ' + entry.href : ''}${entry.hidden ? ' [隐藏]' : ''}`,
    )
    .join('\n')
}
