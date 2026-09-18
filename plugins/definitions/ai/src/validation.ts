import { compile } from './utils.js'
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
    variables: { type: 'object' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'resourceId', 'mimeType'],
        additionalProperties: false,
        properties: {
          type: { enum: ['image', 'file'] },
          resourceId: id,
          mimeType: { type: 'string', minLength: 1 },
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
    thinking: { type: 'string', minLength: 1 },
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
export const validateAgent = compile({
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
  },
})
