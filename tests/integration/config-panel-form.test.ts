import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { supportsForm } from '../../plugins/features/config-panel/client/types.js'
import type { Schema } from '../../plugins/features/config-panel/client/types.js'
import { validateConfig } from '@antarestra/plugin-sdk/schema'

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
