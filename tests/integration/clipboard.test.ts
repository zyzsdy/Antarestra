// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import type { Component } from 'vue'
import { copyText } from '@antarestra/markdown/clipboard'
import { MarkdownContent } from '@antarestra/markdown'
import { feedbackKey } from '@antarestra/webui/client'
import ChatMessage from '../../plugins/features/chat-webui/client/ChatMessage.vue'
import InitialPasswordDialog from '../../plugins/implementations/auth-local/client/InitialPasswordDialog.vue'

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const commandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (commandDescriptor) Object.defineProperty(document, 'execCommand', commandDescriptor)
  else Reflect.deleteProperty(document, 'execCommand')
})

function clipboard(value?: { writeText(text: string): Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}
function fallback(action: () => boolean = () => true) {
  const command = vi.fn(action)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command })
  return command
}
function mount(component: Component, props: object) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(component, props) })
  const toast = vi.fn()
  app.provide(feedbackKey, { toast, notice: vi.fn(), modal: vi.fn(), messagebox: vi.fn() })
  app.mount(host)
  cleanups.push(() => app.unmount())
  return { host, toast }
}

it('优先调用原生剪贴板，保留接收者且不创建临时元素', async () => {
  const native = {
    writeText: vi.fn(async function (this: unknown, text: string) {
      expect(this).toBe(native)
      expect(text).toBe('中文\n内容')
    }),
  }
  clipboard(native)
  const command = fallback()
  expect(await copyText('中文\n内容')).toBe(true)
  expect(command).not.toHaveBeenCalled()
  expect(document.querySelector('textarea')).toBeNull()
})

it.each(['缺失', '拒绝'])(
  '剪贴板 API %s 时回退，保留输入焦点与选区并清理临时元素',
  async (mode) => {
    clipboard(
      mode === '拒绝'
        ? {
            writeText: async () => {
              throw new Error('权限被拒绝')
            },
          }
        : undefined,
    )
    const input = document.createElement('textarea')
    input.value = '未发送草稿'
    document.body.append(input)
    input.focus()
    input.setSelectionRange(1, 4, 'backward')
    const command = fallback(() => {
      const area = document.activeElement as HTMLTextAreaElement
      expect(area).not.toBe(input)
      expect(area.value).toBe('中文\n复制内容')
      expect(area.selectionStart).toBe(0)
      expect(area.selectionEnd).toBe(area.value.length)
      return true
    })
    expect(await copyText('中文\n复制内容')).toBe(true)
    expect(command).toHaveBeenCalledWith('copy')
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      1,
      4,
      'backward',
    ])
    expect(document.querySelectorAll('textarea')).toHaveLength(1)
  },
)

it.each(['false', 'throw'])('备用复制返回 %s 时报告失败并恢复正文选区', async (result) => {
  clipboard()
  const paragraph = document.createElement('p')
  paragraph.textContent = '保留正文选区'
  document.body.append(paragraph)
  const selection = document.getSelection()!
  selection.selectAllChildren(paragraph)
  fallback(() => {
    if (result === 'throw') throw new Error('浏览器禁止复制')
    return false
  })
  expect(await copyText('复制内容')).toBe(false)
  expect(selection.toString()).toBe('保留正文选区')
  expect(document.querySelector('textarea')).toBeNull()
})

it.each([true, false])('聊天消息在 HTTP 环境复制并按真实结果反馈：%s', async (success) => {
  clipboard()
  fallback(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('聊天消息')
    return success
  })
  const { host, toast } = mount(ChatMessage, {
    node: { id: 'n', role: 'user', createdAt: 0, content: [{ type: 'text', text: '聊天消息' }] },
  })
  host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click()
  await nextTick()
  expect(toast).toHaveBeenCalledWith(success ? '已复制消息' : '复制失败，请选中消息文字后手动复制')
})

it.each([true, false])('登录信息弹窗内复制保留焦点且不误报成功：%s', async (success) => {
  clipboard()
  const { host } = mount(InitialPasswordDialog, {
    credentials: {
      loginName: 'test',
      displayName: '测试账号',
      initialPassword: '仅用于测试',
      loginUrl: '/auth/user/',
    },
  })
  await nextTick()
  const button = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('复制登录信息'),
  )!
  button.focus()
  fallback(() => {
    const area = document.activeElement as HTMLTextAreaElement
    expect(area.closest('[role="dialog"]')).not.toBeNull()
    expect(area.value).toContain('初始密码：仅用于测试')
    return success
  })
  button.click()
  await nextTick()
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  expect(document.activeElement).toBe(button)
  expect(button.textContent).toBe(success ? '已复制' : '复制登录信息')
  expect(host.querySelector('[role="alert"]')?.textContent ?? '').toBe(
    success ? '' : '复制失败，请选中上方登录信息后手动复制',
  )
  expect(host.querySelector('textarea')).toBeNull()
})

it('浏览器连备用复制接口也未提供时返回失败', async () => {
  clipboard()
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
  expect(await copyText('复制内容')).toBe(false)
  expect(document.querySelector('textarea')).toBeNull()
})

it.each([true, false])('Markdown 代码块在 HTTP 环境正确反馈复制结果：%s', async (success) => {
  clipboard()
  fallback(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('原样代码\n')
    return success
  })
  const { host } = mount(MarkdownContent, { source: '```text\n原样代码\n```' })
  host.querySelector<HTMLButtonElement>('.md-code-copy')!.click()
  await nextTick()
  expect(host.querySelector('.md-code-label')?.textContent).toBe(success ? '已复制' : '复制失败')
})
