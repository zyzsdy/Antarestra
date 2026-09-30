import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { supportsForm } from '../../plugins/features/config-panel/client/types.js'
import type { Schema } from '../../plugins/features/config-panel/client/types.js'
import { validateConfig } from '@antarestra/plugin-sdk/schema'

async function pluginSchema(directory: string): Promise<Schema> {
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8')) as {
    antarestra: { configSchema: string }
  }
  expect(pkg.antarestra.configSchema).toBe('./config.schema.json')
  return JSON.parse(await readFile(`${directory}/${pkg.antarestra.configSchema}`, 'utf8')) as Schema
}

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
