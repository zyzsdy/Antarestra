import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  resolveFormSchema,
  supportsForm,
} from '../../plugins/features/config-panel/client/types.js'
import type { Schema } from '../../plugins/features/config-panel/client/types.js'

it('模型选择注解通过本地引用保留，仍按对象 Schema 校验', () => {
  const schema: Schema = {
    type: 'object',
    properties: { model: { $ref: '#/$defs/model', 'x-ai-model': true } },
    $defs: {
      model: {
        type: 'object',
        properties: {
          providerId: { type: 'string' },
          modelId: { type: 'string' },
          thinking: { type: 'string' },
        },
      },
    },
  }
  expect(supportsForm(schema)).toBe(true)
  expect(resolveFormSchema(schema)?.properties?.model?.['x-ai-model']).toBe(true)
})
import { validateConfig } from '@antarestra/plugin-sdk/schema'

async function pluginSchema(directory: string): Promise<Schema> {
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8')) as {
    antarestra: { configSchema: string }
  }
  expect(pkg.antarestra.configSchema).toBe('./config.schema.json')
  return JSON.parse(await readFile(`${directory}/${pkg.antarestra.configSchema}`, 'utf8')) as Schema
}

it('IM 命令启动表单只保留前缀和内置开关，不再配置权限', async () => {
  const schema = await pluginSchema('plugins/features/im-commands')
  expect(supportsForm(schema)).toBe(true)
  expect(Object.keys(resolveFormSchema(schema)!.properties!)).toEqual(['prefix', 'builtins'])
  expect(() => validateConfig(schema, { commands: {} })).toThrow()
})

it('OneBot 自动表单移除聊天策略，服务端仍强制令牌二选一', async () => {
  const schema = await pluginSchema('plugins/adapters/im-onebot')
  const original = JSON.stringify(schema)
  expect(supportsForm(schema)).toBe(true)
  const resolved = resolveFormSchema(schema)!
  expect(resolved.properties).not.toHaveProperty('policy')
  expect(JSON.stringify(schema)).toBe(original)
  const base = { id: 'test', selfId: '123456' }
  expect(validateConfig(schema, { ...base, token: 'test-token' })).toMatchObject(base)
  expect(validateConfig(schema, { ...base, tokenEnv: 'ONEBOT_TOKEN' })).toMatchObject(base)
  expect(() => validateConfig(schema, base)).toThrow()
  expect(() =>
    validateConfig(schema, { ...base, token: 'test', tokenEnv: 'ONEBOT_TOKEN' }),
  ).toThrow()
  expect(() =>
    validateConfig(schema, {
      ...base,
      token: 'test',
      policy: { group: { mode: 'blacklist', ids: [] } },
    }),
  ).toThrow()
})

it('本地引用支持 JSON Pointer 转义，并安全拒绝循环、缺失及外部引用', () => {
  const base: Schema = {
    type: 'object',
    properties: { value: { $ref: '#/$defs/a~1b~0c' } },
    $defs: { 'a/b~c': { type: 'string' } },
  }
  expect(resolveFormSchema(base)?.properties?.value?.type).toBe('string')
  for (const reference of [
    '#/$defs/missing',
    'https://example.test/schema',
    '#/$defs/%invalid',
    '#/$defs/loop',
  ]) {
    expect(
      supportsForm({
        ...base,
        properties: { value: { $ref: reference } },
        $defs: { loop: { $ref: '#/$defs/loop' } },
      }),
    ).toBe(false)
  }
  expect(
    supportsForm({
      type: 'object',
      properties: { child: { $ref: '#/$defs/node' } },
      $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
    }),
  ).toBe(false)
  expect(
    supportsForm({
      type: 'object',
      properties: {},
      oneOf: [{ properties: { extra: { type: 'string' } } }],
    }),
  ).toBe(false)
})

it('存储定义插件通过包元数据提供空配置自动表单，连接配置归实现插件所有', async () => {
  const schema = await pluginSchema('plugins/definitions/storage')
  expect(supportsForm(schema)).toBe(true)
  expect(schema.properties).toEqual({})
  expect(validateConfig(schema, {})).toEqual({})
  expect(() => validateConfig(schema, { endpoint: 'http://localhost:19000' })).toThrow()
})

it('S3 实现插件提供自动表单，凭据字段默认遮罩且保留环境变量引用', async () => {
  const schema = await pluginSchema('plugins/implementations/storage-s3')
  expect(supportsForm(schema)).toBe(true)
  expect(schema.properties?.accessKeyId?.['x-sensitive']).toBe(true)
  expect(schema.properties?.secretAccessKey?.['x-sensitive']).toBe(true)
  expect(
    validateConfig(schema, {
      endpoint: 'http://localhost:19000',
      bucket: 'test',
      accessKeyId: '$ANTARESTRA_S3_ACCESS_KEY',
      secretAccessKey: '$ANTARESTRA_S3_SECRET_KEY',
    }),
  ).toMatchObject({
    accessKeyId: '$ANTARESTRA_S3_ACCESS_KEY',
    secretAccessKey: '$ANTARESTRA_S3_SECRET_KEY',
    forcePathStyle: true,
  })
})

it('Markdown 渲染插件无需配置也声明 Schema 并支持自动表单', async () => {
  const schema = await pluginSchema('plugins/features/markdown-render')
  expect(supportsForm(schema)).toBe(true)
  expect(schema.properties).toEqual({})
  expect(validateConfig(schema, {})).toEqual({})
  expect(() => validateConfig(schema, { unknown: true })).toThrow()
})

it('IM 接入管理声明空配置自动表单，聊天规则不属于插件启动配置', async () => {
  const schema = await pluginSchema('plugins/features/im-console')
  expect(supportsForm(schema)).toBe(true)
  expect(schema.properties).toEqual({})
  expect(validateConfig(schema, {})).toEqual({})
  expect(() => validateConfig(schema, { policy: {} })).toThrow()
})

it('数据库配置提供自动表单，同时保留数据库类型的条件校验和敏感字段', async () => {
  const schema = JSON.parse(
    await readFile('plugins/implementations/database-kysely/config.schema.json', 'utf8'),
  ) as Schema
  expect(supportsForm(schema)).toBe(true)
  expect(schema.properties?.url?.['x-sensitive']).toBe(true)
  expect(validateConfig(schema, { type: 'sqlite', filename: ':memory:' })).toMatchObject({
    type: 'sqlite',
  })
  expect(
    validateConfig(schema, { type: 'postgresql', url: 'postgres://localhost/test' }),
  ).toMatchObject({ type: 'postgresql' })
  expect(() => validateConfig(schema, { type: 'mysql' })).toThrow()
  expect(() => validateConfig(schema, { type: 'sqlite', url: 'invalid' })).toThrow()
  expect(supportsForm({ ...schema, allOf: [{ properties: { extra: { type: 'object' } } }] })).toBe(
    false,
  )
})
