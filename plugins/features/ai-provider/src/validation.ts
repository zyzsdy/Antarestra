import { AuthError } from '@antarestra/rbac'
import type { ModelDefinition } from '@antarestra/ai'
import { apiFormats, thinkingLevels } from './types.js'
import type { ProviderRecord, ProviderView } from './types.js'
import type { BuiltinTool } from './types.js'

export function validateBuiltinTools(value: unknown, models: ModelDefinition[]): BuiltinTool[] {
  check(Array.isArray(value) && value.length <= 100, '内置工具列表无效')
  const tools = value.map((entry) => {
    const v = object(entry)
    const name = identifier(v.name)
    check(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name),
      '工具名需为字母开头的 1–64 位字母、数字、下划线或短横线',
    )
    const type = identifier(v.type)
    check(
      /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(type) && !['function', 'custom'].includes(type),
      '内置工具类型需为 1–100 位标识，不能使用客户端 function 或 custom 类型',
    )
    check(typeof v.enabled === 'boolean', '启用状态无效')
    check(
      Array.isArray(v.modelIds) &&
        v.modelIds.length > 0 &&
        v.modelIds.every((id) => models.some((m) => m.id === id && m.tools)),
      '请选择已有且支持工具的模型',
    )
    const options = object(v.options)
    check(
      !Object.hasOwn(options, 'type') && !Object.hasOwn(options, 'name'),
      '选项不能覆盖工具类型或名称',
    )
    check(JSON.stringify(options).length <= 16000, '工具选项最多 16000 字')
    return {
      name,
      type,
      enabled: v.enabled,
      modelIds: [...new Set(v.modelIds as string[])],
      options,
    } as BuiltinTool
  })
  check(new Set(tools.map((t) => t.name)).size === tools.length, '内置工具名称重复')
  check(new Set(tools.map((t) => t.type)).size === tools.length, '同一提供商的内置工具类型不能重复')
  return tools
}

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new AuthError(400, message)
}
export function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), '请输入有效对象')
  return value as Record<string, unknown>
}
export function text(value: unknown, label: string, max = 200, empty = false): string {
  check(typeof value === 'string' && value.length <= max && (empty || value.trim()), `${label}无效`)
  return value
}
export function identifier(value: unknown): string {
  const id = text(value, 'ID')
  check(!/[\s\x00-\x1f]/.test(id), 'ID 不能包含空白或控制字符')
  return id
}
export function validateModel(value: unknown): ModelDefinition {
  const v = object(value)
  const contextWindow = v.contextWindow
  const maxOutputTokens = v.maxOutputTokens
  check(Number.isSafeInteger(contextWindow) && Number(contextWindow) > 0, '上下文必须是正整数')
  check(
    Number.isSafeInteger(maxOutputTokens) &&
      Number(maxOutputTokens) > 0 &&
      Number(maxOutputTokens) <= Number(contextWindow),
    '最大输出必须是正整数且不超过上下文',
  )
  check(
    Array.isArray(v.thinkingLevels) && v.thinkingLevels.every((x) => thinkingLevels.includes(x)),
    '思考强度无效',
  )
  check(
    Array.isArray(v.input) &&
      v.input.includes('text') &&
      v.input.every((x) => ['text', 'image'].includes(x)),
    '输入功能无效',
  )
  check(
    Array.isArray(v.output) && v.output.length === 1 && v.output[0] === 'text',
    '当前仅支持文本输出',
  )
  check(typeof v.tools === 'boolean', '工具调用功能无效')
  return {
    id: identifier(v.id),
    title: text(v.title, '显示名称'),
    contextWindow: Number(contextWindow),
    maxOutputTokens: Number(maxOutputTokens),
    thinkingLevels: [...new Set(v.thinkingLevels as string[])],
    input: [...new Set(v.input as ModelDefinition['input'])],
    output: ['text'],
    tools: v.tools,
  }
}
export function validateProvider(value: unknown, previous?: ProviderRecord): ProviderRecord {
  const v = object(value)
  const id = identifier(v.id)
  check(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id), '提供商 ID 仅支持字母、数字、点、短横线和下划线')
  const api = text(v.api, '接口格式')
  check(
    apiFormats.some((x) => x.id === api),
    '不支持的接口格式',
  )
  const baseUrl = text(v.baseUrl, 'Base URL', 2000)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new AuthError(400, 'Base URL 无效')
  }
  check(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'Base URL 必须是无凭据、查询参数及片段的 HTTP(S) 地址',
  )
  const headers = object(v.headers)
  check(Object.keys(headers).length <= 50, '额外 Header 不能超过 50 项')
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(headers)) {
    check(
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) &&
        !['host', 'content-length', 'connection'].includes(key.toLowerCase()),
      'Header 名称无效',
    )
    const item = text(value, 'Header 值', 8000, true)
    check(!/[\r\n\x00]/.test(item), 'Header 值不能包含换行')
    check(!Object.hasOwn(normalized, key.toLowerCase()), 'Header 名称重复')
    normalized[key.toLowerCase()] = item
  }
  const replacement = v.apiKey === undefined ? '' : text(v.apiKey, 'API Key', 8000, true)
  check(!/[\r\n\x00]/.test(replacement), 'API Key 不能包含换行')
  check(!replacement || !replacement.includes('*'), '请输入新的 API Key，不能提交脱敏值')
  return {
    id,
    name: text(v.name, '名称'),
    note: text(v.note, '备注', 2000, true),
    builtin: text(v.builtin, '内置提供商', 200, true),
    api,
    baseUrl,
    apiKey: replacement || previous?.apiKey || '',
    headers: normalized,
    models: previous?.models ?? [],
    builtinTools: previous?.builtinTools ?? [],
    revision: (previous?.revision ?? 0) + 1,
  }
}
export function publicProvider(record: ProviderRecord): ProviderView {
  const { apiKey, ...rest } = structuredClone(record)
  return {
    ...rest,
    apiKeyPlaceholder:
      apiKey.length > 7
        ? `${apiKey.slice(0, 3)}${'*'.repeat(Math.max(4, apiKey.length - 7))}${apiKey.slice(-4)}`
        : apiKey
          ? '*******'
          : '',
  }
}
