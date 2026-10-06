// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { expect, it } from 'vitest'
import {
  parseFormYaml,
  updateFormYaml,
  orderedEntries,
  orderedRecord,
} from '../../plugins/features/config-panel/client/form-values.js'
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
    expect(input('config-policy-chats-key-0').value).toBe('123')
    await fill('config-policy-group-defaults-activation-cooldownMs', '1500')
    expect(changes.at(-1)).toEqual([
      ['policy', 'group', 'defaults', 'activation', 'cooldownMs'],
      1500,
      undefined,
    ])
    input('config-policy-chats-key-0').value = '456'
    input('config-policy-chats-key-0').dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(changes.at(-1)).toEqual([['policy', 'chats'], { '456': { ai: true } }, undefined])
    const collection = host.querySelector('[aria-label="chats表格"]')!.parentElement!
    ;[...collection.querySelectorAll('button')]
      .find((button) => button.textContent === '使用环境变量')!
      .click()
    await nextTick()
    await fill('config-policy-chats', '$ONEBOT_CHATS')
    expect(changes.at(-1)?.[1]).toBe('$ONEBOT_CHATS')
    host.querySelector<HTMLButtonElement>('[aria-label="移除 chats"]')!.click()
    await nextTick()
    expect(changes.at(-1)).toEqual([['policy', 'chats'], undefined, true])
    expect(host.textContent).toContain('暂无条目')
    expect(value.token).toBe('test-token')
  } finally {
    app.unmount()
    host.remove()
  }
})

it('表格编辑对象字典与数组，拒绝重复键，保留类型、未知字段和环境引用', async () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      dict: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            token: { type: 'string', format: 'password' },
            count: { type: 'integer' },
          },
        },
      },
      list: { type: 'array', items: { type: 'integer' } },
      nested: { type: 'array', items: { type: 'array', items: { type: 'boolean' } } },
    },
  }
  const value = reactive<Record<string, unknown>>({
    dict: {
      alpha: { token: '$TOKEN', count: 1, extra: '保留' },
      beta: { token: '$OTHER', count: 2 },
    },
    list: [1, 2],
    nested: [[true]],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () =>
      h(SchemaForm, {
        schema,
        value,
        onChange: (path, item, remove) => {
          if (remove) delete value[path[0]!]
          else value[path[0]!] = item
        },
      }),
  })
  app.mount(host)
  const region = (name: string) => host.querySelector(`[aria-label="${name}表格"]`)!.parentElement!
  const click = async (root: Element, label: string) => {
    root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
    await nextTick()
  }
  const fill = async (id: string, text: string, event = 'input') => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!
    input.value = text
    input.dispatchEvent(new Event(event, { bubbles: true }))
    await nextTick()
  }
  try {
    expect(host.querySelector<HTMLInputElement>('#config-dict-0-token')!.type).toBe('password')
    await fill('config-dict-0-count', '7')
    expect(value.dict).toMatchObject({ alpha: { count: 7, extra: '保留', token: '$TOKEN' } })
    await fill('config-dict-key-0', 'beta', 'change')
    expect(host.textContent).toContain('键已存在')
    expect(Object.keys(value.dict as object)).toEqual(['alpha', 'beta'])
    await fill('config-dict-key-0', '', 'change')
    expect(host.textContent).toContain('键不能为空')
    await fill('config-dict-key-0', '__proto__', 'change')
    expect(Object.hasOwn(value.dict as object, '__proto__')).toBe(true)
    await click(region('dict'), '下移第 1 行')
    expect(Object.keys(value.dict as object)).toEqual(['beta', '__proto__'])
    await click(region('dict'), '删除第 1 行')
    expect(Object.keys(value.dict as object)).toEqual(['__proto__'])
    ;[...region('dict').querySelectorAll('button')]
      .find((button) => button.textContent === '添加行')!
      .click()
    await nextTick()
    expect(Object.keys(value.dict as object)).toEqual(['__proto__', '新键'])
    await fill('config-list-0-value', '3')
    await click(region('list'), '下移第 1 行')
    expect(value.list).toEqual([2, 3])
    await click(region('list'), '删除第 1 行')
    expect(value.list).toEqual([3])
    ;[...region('list').querySelectorAll('button')]
      .find((button) => button.textContent === '添加行')!
      .click()
    await nextTick()
    expect(value.list).toEqual([3, 0])
    expect(host.querySelector('#config-nested-0-value-0-value')).not.toBeNull()
  } finally {
    app.unmount()
    host.remove()
  }
})

it('纯数字字典键的顺序经过 YAML 与表单往返仍保持，嵌套值不改变类型', () => {
  const yaml = 'dict:\n  "20": { count: 2 }\n  "3": { count: 1 }\n'
  const value = parseFormYaml(yaml) as Record<string, unknown>
  const entries = orderedEntries(value.dict as Record<string, unknown>)
  expect(entries.map(([key]) => key)).toEqual(['20', '3'])
  const updated = updateFormYaml(yaml, ['dict'], orderedRecord(entries.reverse()))
  const roundtrip = parseFormYaml(updated) as Record<string, unknown>
  expect(orderedEntries(roundtrip.dict as Record<string, unknown>).map(([key]) => key)).toEqual([
    '3',
    '20',
  ])
  expect(roundtrip.dict).toEqual({ '3': { count: 1 }, '20': { count: 2 } })
})
