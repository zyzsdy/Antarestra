import { check, compile } from './utils.js'
import { validTokenAmount } from '@antarestra/contracts'
import type { AgentPreset } from '@antarestra/contracts'
import type { JsonObject } from '@antarestra/contracts'
const id: JsonObject = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[^\\u0000-\\u001f]+$',
}
const ref: JsonObject = {
  type: 'object',
  required: ['providerId', 'modelId'],
  properties: { providerId: id, modelId: id },
  additionalProperties: false,
}
const input: JsonObject = {
  type: 'object',
  required: ['text'],
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    expandTemplateVariables: { type: 'boolean' },
    variables: { type: 'object' },
    attachments: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['type', 'resourceId', 'mimeType'],
        additionalProperties: false,
        properties: {
          type: { enum: ['image', 'file'] },
          resourceId: id,
          mimeType: { type: 'string', minLength: 1 },
          filename: { type: 'string', maxLength: 255 },
          url: { type: 'string', maxLength: 1000 },
          size: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
}
export const validateCommand = compile({
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'expectedRevision', 'expectedNodeId', 'idempotencyKey'],
  properties: {
    operation: { enum: ['send', 'edit', 'regenerate'] },
    expectedRevision: { type: 'integer', minimum: 0 },
    expectedNodeId: { anyOf: [id, { type: 'null' }] },
    idempotencyKey: id,
    targetNodeId: id,
    input,
    model: ref,
    thinking: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
  },
  allOf: [
    {
      if: { properties: { operation: { enum: ['send', 'edit'] } } },
      then: { required: ['input'] },
    },
    {
      if: { properties: { operation: { enum: ['edit', 'regenerate'] } } },
      then: { required: ['targetNodeId'] },
    },
  ],
})
const validateAgentSchema = compile({
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'version',
    'title',
    'backendId',
    'systemTemplate',
    'userTemplate',
    'models',
    'defaultModel',
    'toolIds',
    'skillIds',
    'extensions',
  ],
  properties: {
    id,
    version: id,
    title: { type: 'string' },
    backendId: id,
    systemTemplate: { type: 'string' },
    userTemplate: { type: 'string' },
    models: { type: 'array', minItems: 1, uniqueItems: true, items: ref },
    defaultModel: ref,
    defaultThinking: { type: 'string' },
    toolIds: { type: 'array', uniqueItems: true, items: id },
    skillIds: { anyOf: [{ type: 'null' }, { type: 'array', uniqueItems: true, items: id }] },
    extensions: { type: 'object', additionalProperties: { type: 'object' } },
    contextPolicy: {
      type: 'object',
      additionalProperties: false,
      required: ['compaction', 'trimming'],
      properties: {
        compaction: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'reserve', 'keepRecent', 'model', 'thinking'],
          properties: {
            enabled: { type: 'boolean' },
            reserve: {},
            keepRecent: {},
            model: { anyOf: [ref, { type: 'null' }] },
            thinking: { anyOf: [id, { type: 'null' }] },
          },
        },
        trimming: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'mode', 'rounds', 'keepFirst'],
          properties: {
            enabled: { type: 'boolean' },
            mode: { enum: ['auto', 'rounds'] },
            rounds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            keepFirst: { type: 'boolean' },
          },
        },
      },
    },
  },
})
export function validateAgent(value: unknown) {
  validateAgentSchema(value)
  const policy = (value as AgentPreset).contextPolicy
  if (policy) {
    check(
      validTokenAmount(policy.compaction.reserve),
      '输出预留需为正整数或 0% 到 100% 之间的百分比',
    )
    check(
      validTokenAmount(policy.compaction.keepRecent),
      '近期保留窗口需为正整数或 0% 到 100% 之间的百分比',
    )
  }
}
