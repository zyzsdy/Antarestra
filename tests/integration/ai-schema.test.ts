import { describe, expect, it } from 'vitest'
import type { JsonObject } from '@antarestra/contracts'
import { compile } from '../../plugins/definitions/ai/src/utils.js'
import { schemaDialect } from '../../plugins/definitions/ai/src/schema.js'

describe('AI 参数 Schema 统一迁移', () => {
  it('校验器缓存识别调用方修改，规范化结果不可变', () => {
    const schema = { type: 'string', minLength: 2 }
    const first = compile(schema)
    expect(compile(schema)).toBe(first)
    expect(Object.isFrozen(first.schema)).toBe(true)
    schema.minLength = 4
    const second = compile(schema)
    expect(second).not.toBe(first)
    expect(() => first('ab')).not.toThrow()
    expect(() => second('ab')).toThrow()
  })

  it('不同工具的同名资源各自独立，清理缓存不影响已有校验器', () => {
    const schema = (type: string) => ({
      $id: 'https://example.invalid/tool',
      $defs: { value: { $id: 'value', type } },
      $ref: 'value',
    })
    const text = compile(schema('string'))
    const number = compile(schema('number'))
    expect(() => text('a')).not.toThrow()
    expect(() => text(1)).toThrow()
    expect(() => number(1)).not.toThrow()
    expect(() => number('a')).toThrow()
  })

  it('新版兼容 dependencies 也转换引用，重复依赖不会被覆盖', () => {
    const validate = compile({
      $schema: schemaDialect,
      type: 'object',
      definitions: { dependency: { required: ['b'] } },
      dependencies: { a: { $ref: '#/definitions/dependency' } },
      dependentRequired: { c: ['d'] },
    })
    expect(() => validate({ a: 1, b: 2, c: 3, d: 4 })).not.toThrow()
    expect(() => validate({ a: 1 })).toThrow()
    expect(() => validate({ c: 1 })).toThrow()
    expect(() =>
      compile({
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        dependencies: { a: ['b'] },
        dependentRequired: { a: ['c'] },
      }),
    ).toThrow('依赖声明冲突')
  })

  it('嵌套资源内外的引用与转义指针同步更新', () => {
    const validate = compile({
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.invalid/root',
      definitions: {
        embedded: {
          $id: 'child',
          definitions: { 'x/y~': { type: 'string' } },
          type: 'object',
          properties: { v: { $ref: '#/definitions/x~1y~0' } },
        },
      },
      type: 'object',
      properties: {
        local: { $ref: '#/definitions/embedded' },
        external: { $ref: 'child#/definitions/x~1y~0' },
        pointer: { $ref: '#/definitions/embedded/definitions/x~1y~0' },
      },
    })
    expect(() => validate({ local: { v: 'a' }, external: 'b', pointer: 'c' })).not.toThrow()
    for (const input of [{ local: { v: 1 } }, { external: 1 }, { pointer: 1 }])
      expect(() => validate(input)).toThrow()
  })

  it.each(['04', '06', '07'])('draft-%s 元组、依赖和定义引用保持约束', (draft) => {
    const schema: JsonObject = {
      $schema: `http://json-schema.org/draft-${draft}/schema#`,
      type: 'object',
      definitions: { name: { type: 'string', minLength: 2 } },
      properties: {
        pair: {
          type: 'array',
          items: [{ $ref: '#/definitions/name' }, { type: 'integer' }],
          additionalItems: false,
        },
        enabled: { type: 'boolean' },
        name: { $ref: '#/properties/pair/items/0' },
      },
      dependencies: { enabled: ['name'], name: { required: ['pair'] } },
      additionalProperties: false,
    }
    const original = structuredClone(schema)
    const validate = compile(schema)
    expect(schema).toEqual(original)
    expect(validate.schema).toMatchObject({
      $schema: schemaDialect,
      $defs: { name: { type: 'string', minLength: 2 } },
      properties: {
        pair: { prefixItems: [{ $ref: '#/$defs/name' }, { type: 'integer' }], items: false },
        name: { $ref: '#/properties/pair/prefixItems/0' },
      },
      dependentRequired: { enabled: ['name'] },
      dependentSchemas: { name: { required: ['pair'] } },
    })
    expect(() => validate({ enabled: true, name: 'ok', pair: ['ok', 2] })).not.toThrow()
    for (const value of [
      { enabled: true },
      { name: 'ok' },
      { pair: ['x', 2] },
      { pair: ['ok', 2, 3] },
      { pair: ['ok', '2'] },
    ])
      expect(() => validate(value)).toThrow('参数不符合')
  })

  it('draft-04 排他边界与 id 锚点迁移，draft-07 数值边界不丢失', () => {
    const old = compile({
      $schema: 'https://json-schema.org/draft-04/schema#',
      id: 'https://example.invalid/number',
      definitions: {
        number: {
          id: '#positive',
          type: 'number',
          minimum: 0,
          exclusiveMinimum: true,
          maximum: 10,
          exclusiveMaximum: false,
        },
      },
      $ref: '#positive',
    })
    expect(old.schema.$id).toBe('https://example.invalid/number')
    expect(() => old(0)).toThrow()
    expect(() => old(10)).not.toThrow()
    const modern = compile({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 10,
    })
    expect(() => modern(0)).toThrow()
    expect(() => modern(10)).toThrow()
    expect(() => modern(5)).not.toThrow()
  })

  it('旧 $ref 忽略断言兄弟，仍可引用兄弟下的 Schema', () => {
    const validate = compile({
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: { text: { type: 'string' } },
      type: 'object',
      properties: {
        a: {
          $ref: '#/definitions/text',
          type: 'integer',
          properties: { hidden: { type: 'boolean' } },
        },
        b: { $ref: '#/properties/a/properties/hidden' },
      },
    })
    expect(() => validate({ a: '文字', b: true })).not.toThrow()
    expect(() => validate({ a: 1 })).toThrow()
    expect(() => validate({ b: '错误' })).toThrow()
  })

  it('识别省略方言的旧结构，不改动默认值、枚举、示例与关键字同名属性', () => {
    const literal = {
      $schema: '用户数据',
      items: [{ dependencies: { x: ['y'] } }],
      definitions: {},
    }
    const schema: JsonObject = {
      type: 'object',
      properties: {
        items: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
        definitions: { const: literal, default: literal, examples: [literal] },
      },
    }
    const validate = compile(schema)
    expect(validate.schema.$schema).toBe(schemaDialect)
    expect(validate.schema.properties).toMatchObject({
      definitions: { const: literal, default: literal, examples: [literal] },
    })
    expect(() => validate({ items: ['a'], definitions: literal })).not.toThrow()
    expect(() => validate({ items: ['a', 'b'] })).toThrow()
  })

  it('2019-09 递归锚点迁移为动态引用', () => {
    const validate = compile({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $recursiveAnchor: true,
      type: 'object',
      properties: {
        value: { type: 'string' },
        children: { type: 'array', items: { $recursiveRef: '#' } },
      },
      required: ['value'],
    })
    expect(validate.schema.$dynamicAnchor).toBe('antarestra_recursive')
    expect(() => validate({ value: '根', children: [{ value: '叶' }] })).not.toThrow()
    expect(() => validate({ value: '根', children: [{ value: 1 }] })).toThrow()
  })

  it('2019-09 未声明递归锚点时维持静态根引用', () => {
    const validate = compile({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      type: 'object',
      properties: { value: { type: 'string' }, child: { $recursiveRef: '#' } },
    })
    expect(() => validate({ child: { value: '叶' } })).not.toThrow()
    expect(() => validate({ child: { value: 1 } })).toThrow()
  })

  it('定义名中的 URI 字符与特殊对象键保持可引用', () => {
    const schema = JSON.parse(
      '{"$schema":"http://json-schema.org/draft-07/schema#","definitions":{"100%":{"type":"number"},"__proto__":{"type":"string"}},"type":"object","properties":{"n":{"$ref":"#/definitions/100%25"},"s":{"$ref":"#/definitions/__proto__"}}}',
    ) as JsonObject
    const validate = compile(schema)
    expect(() => validate({ n: 1, s: '文字' })).not.toThrow()
    expect(() => validate({ n: '错误' })).toThrow()
    expect(() => validate({ s: 1 })).toThrow()
  })

  it('2020-12 的 $ref 兄弟约束和 prefixItems 保持生效，转换可重复', () => {
    const validate = compile({
      $schema: schemaDialect,
      $defs: { number: { type: 'number' } },
      type: 'array',
      prefixItems: [{ $ref: '#/$defs/number', minimum: 2 }],
      items: false,
    })
    expect(compile(validate.schema).schema).toEqual(validate.schema)
    expect(() => validate([2])).not.toThrow()
    expect(() => validate([1])).toThrow()
    expect(() => validate([2, 3])).toThrow()
  })

  it('未知方言、非法旧 Schema 与无法无损迁移的组合明确拒绝', () => {
    expect(() => compile({ $schema: 'https://example.invalid/schema', type: 'object' })).toThrow(
      '不支持的方言',
    )
    expect(() =>
      compile({ $schema: 'http://json-schema.org/draft-07/schema#', items: [] }),
    ).toThrow()
    expect(() =>
      compile({ $schema: 'http://json-schema.org/draft-04/schema#', exclusiveMinimum: true }),
    ).toThrow()
    expect(() =>
      compile({
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        contains: { type: 'string' },
        unevaluatedItems: false,
      }),
    ).toThrow('显式迁移')
    expect(() =>
      compile({
        $schema: schemaDialect,
        properties: { old: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' } },
      }),
    ).toThrow('混合方言')
    expect(() =>
      compile({
        $schema: 'http://json-schema.org/draft-07/schema#',
        contains: { type: 'string' },
        maxContains: 1,
      }),
    ).toThrow('2019-09 关键字')
  })
})
