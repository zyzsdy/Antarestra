// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { expect, it } from 'vitest'
import SchemaForm from '../../plugins/features/config-panel/client/SchemaForm.vue'
import type { Schema } from '../../plugins/features/config-panel/client/types.js'

it('通用表单保留嵌套编辑路径、动态对象和无效草稿，并遮罩令牌', async () => {
  const schema: Schema = {
    type: 'object',
    $defs: {
      chat: {
        type: 'object',
        properties: {
          ai: { type: 'boolean' },
          activation: { type: 'object', properties: { cooldownMs: { type: 'integer' } } },
        },
      },
      access: { type: 'object', properties: { defaults: { $ref: '#/$defs/chat' } } },
    },
    properties: {
      policy: {
        type: 'object',
        properties: {
          group: { $ref: '#/$defs/access' },
          private: { $ref: '#/$defs/access' },
          chats: { type: 'object', additionalProperties: { $ref: '#/$defs/chat' } },
        },
      },
      token: { type: 'string', format: 'password' },
    },
  }
  const value = reactive<Record<string, unknown>>({
    policy: { chats: { '123': { ai: true } } },
    token: 'test-token',
  })
  const changes: [string[], unknown, boolean | undefined][] = []
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () =>
      h(SchemaForm, {
        schema,
        value,
        onChange: (path, item, remove) => {
          changes.push([path, item, remove])
          let parent = value
          for (const key of path.slice(0, -1)) {
            parent[key] ??= {}
            parent = parent[key] as Record<string, unknown>
          }
          const key = path.at(-1)!
          if (remove) delete parent[key]
          else parent[key] = item
        },
      }),
  })
  app.mount(host)
  const input = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!
  async function fill(id: string, text: string) {
    input(id).value = text
    input(id).dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }
  try {
    expect(input('config-token').type).toBe('password')
    expect(input('config-token').autocomplete).toBe('new-password')
    expect(input('config-policy-chats').value).toBe('{"123":{"ai":true}}')
    await fill('config-policy-group-defaults-activation-cooldownMs', '1500')
    expect(changes.at(-1)).toEqual([
      ['policy', 'group', 'defaults', 'activation', 'cooldownMs'],
      1500,
      undefined,
    ])
    await fill('config-policy-chats', '{"456":{"ai":false}}')
    expect(changes.at(-1)).toEqual([['policy', 'chats'], { '456': { ai: false } }, undefined])
    await fill('config-policy-chats', '{')
    expect(input('config-policy-chats').value).toBe('{')
    expect(changes.at(-1)?.[1]).toBe('{')
    await fill('config-policy-chats', '$ONEBOT_CHATS')
    expect(changes.at(-1)?.[1]).toBe('$ONEBOT_CHATS')
    host.querySelector<HTMLButtonElement>('[aria-label="移除 chats"]')!.click()
    await nextTick()
    expect(changes.at(-1)).toEqual([['policy', 'chats'], undefined, true])
    expect(input('config-policy-chats').value).toBe('')
    expect(value.token).toBe('test-token')
  } finally {
    app.unmount()
    host.remove()
  }
})
