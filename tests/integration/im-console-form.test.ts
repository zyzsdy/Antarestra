// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import type { ChatPolicy, ConnectionPolicy } from '@antarestra/im'
import PolicyForm from '../../plugins/features/im-console/client/PolicyForm.vue'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

function mount(policy: ConnectionPolicy) {
  const host = document.createElement('div')
  document.body.append(host)
  const busy = ref(false)
  const save = vi.fn()
  const dirty = vi.fn()
  const app = createApp({
    render: () => h(PolicyForm, { policy, busy: busy.value, onSave: save, onDirty: dirty }),
  })
  app.mount(host)
  cleanup.push(() => {
    app.unmount()
    host.remove()
  })
  const field = (id: string) => host.querySelector<HTMLTextAreaElement>(`[id="${id}"]`)!
  return {
    host,
    busy,
    save,
    dirty,
    field,
    async fill(id: string, value: string) {
      const input = field(id)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
    },
    async submit() {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }))
      await nextTick()
    },
  }
}

it.each(['group', 'private'] as const)(
  '%s 名单保留输入中的换行和光标，保存时清理并去重',
  async (type) => {
    const policy: ConnectionPolicy = { [type]: { mode: 'whitelist', ids: ['00123'] } }
    const form = mount(policy)
    const id = `im-${type}-ids`
    await form.fill(id, '00123\n')
    expect(form.field(id).value).toBe('00123\n')
    expect(form.field(id).selectionStart).toBe(6)
    await form.fill(id, '00123\n\n 00456 \n00123\n')
    expect(form.field(id).value).toBe('00123\n\n 00456 \n00123\n')
    expect(form.dirty).toHaveBeenCalled()
    await form.submit()
    expect(form.save).toHaveBeenCalledWith(
      expect.objectContaining({
        [type]: expect.objectContaining({ ids: ['00123', '00456'] }),
      }),
    )
    expect(form.field(id).value).toBe('00123\n\n 00456 \n00123\n')
    expect(policy[type]!.ids).toEqual(['00123'])
    await form.fill(id, '\n \n')
    await form.submit()
    expect(form.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        [type]: expect.objectContaining({ ids: [] }),
      }),
    )
  },
)

const scopes = [
  { id: 'im-default', policy: (value: ChatPolicy): ConnectionPolicy => ({ defaults: value }) },
  {
    id: 'im-group',
    policy: (value: ChatPolicy): ConnectionPolicy => ({
      group: { mode: 'whitelist', ids: [], defaults: value },
    }),
  },
  {
    id: 'im-private',
    policy: (value: ChatPolicy): ConnectionPolicy => ({
      private: { mode: 'whitelist', ids: [], defaults: value },
    }),
  },
  {
    id: 'im-chat-group:00123',
    policy: (value: ChatPolicy): ConnectionPolicy => ({ chats: { 'group:00123': value } }),
  },
]

it.each(scopes)('$id 的前缀、关键词和模板保留空行，保存时统一规范化', async ({ id, policy }) => {
  const original: ChatPolicy = { activation: { prefixes: ['/ai'] } }
  const form = mount(policy(original))
  for (const suffix of ['prefix', 'keywords']) {
    await form.fill(`${id}-${suffix}`, '第一行\n')
    expect(form.field(`${id}-${suffix}`).value).toBe('第一行\n')
    await form.fill(`${id}-${suffix}`, '第一行\n\n 第二行 \n')
  }
  await form.fill(`${id}-user-input`, '\n\n')
  // 模拟保存期间的重渲染，不能让只含换行的草稿被默认值覆盖。
  form.busy.value = true
  await nextTick()
  expect(form.field(`${id}-user-input`).value).toBe('\n\n')
  expect(form.field(`${id}-user-input`).disabled).toBe(true)
  form.busy.value = false
  await nextTick()
  await form.submit()
  const expected = policy({
    activation: { prefixes: ['第一行', '第二行'], keywords: ['第一行', '第二行'] },
  })
  expect(form.save).toHaveBeenCalledWith(expect.objectContaining(expected))
  expect(form.field(`${id}-prefix`).value).toBe('第一行\n\n 第二行 \n')
  const template = '\n {{last_message}}\n\n'
  await form.fill(`${id}-user-input`, template)
  await form.submit()
  expect(form.save).toHaveBeenLastCalledWith(
    expect.objectContaining(
      policy({
        activation: { prefixes: ['第一行', '第二行'], keywords: ['第一行', '第二行'] },
        userInputTemplate: template,
      }),
    ),
  )
  expect(original).toEqual({ activation: { prefixes: ['/ai'] } })
})

it('空白激活条件不能绕过校验，保存失败保留未规范化草稿', async () => {
  const form = mount({ defaults: { activation: { prefixes: ['/ai'] } } })
  await form.fill('im-default-prefix', '\n \n')
  await form.fill('im-default-keywords', '\n')
  await form.submit()
  expect(form.save).not.toHaveBeenCalled()
  expect(form.host.querySelector('[role="alert"]')?.textContent).toContain('至少选择一种')
  expect(form.field('im-default-prefix').value).toBe('\n \n')
  await form.fill('im-default-prefix', '\n /ai\n')
  await form.submit()
  expect(form.save).toHaveBeenCalledWith(
    expect.objectContaining({
      defaults: { activation: { prefixes: ['/ai'], keywords: [] } },
    }),
  )
})
