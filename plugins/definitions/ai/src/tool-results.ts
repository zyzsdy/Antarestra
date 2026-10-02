import type { ContentBlock, ToolImage } from '@antarestra/contracts'
import type { ResolvedResource, StructuredToolResult } from './types.js'
import { check } from './utils.js'

export function validateToolImages(images: unknown): asserts images is ToolImage[] {
  check(Array.isArray(images) && images.length <= 20, '工具图片列表无效')
  for (const image of images) {
    check(image && typeof image === 'object' && image.type === 'image', '工具图片无效')
    check(typeof image.resourceId === 'string' && image.resourceId.length > 0, '图片资源标识无效')
    check(/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType), '图片类型无效')
    check(typeof image.filename === 'string' && image.filename.length <= 255, '图片文件名无效')
    check(
      Number.isSafeInteger(image.size) && image.size > 0 && image.size <= 8 * 1024 ** 2,
      '图片超过 8 MiB',
    )
    check(
      Number.isSafeInteger(image.width) &&
        image.width > 0 &&
        Number.isSafeInteger(image.height) &&
        image.height > 0,
      '图片尺寸无效',
    )
  }
}
export function structuredResult(value: unknown): StructuredToolResult {
  check(
    value !== null && typeof value === 'object' && !Array.isArray(value) && 'content' in value,
    '结构化工具结果缺少 content',
  )
  const result = value as StructuredToolResult
  check(result.isError === undefined || typeof result.isError === 'boolean', '工具错误状态无效')
  if (result.images !== undefined) validateToolImages(result.images)
  return result
}
export function messageResources(
  block: ContentBlock,
): Extract<ContentBlock, { resourceId: string }>[] {
  return block.type === 'tool-result'
    ? (block.images ?? [])
    : block.type === 'image' || block.type === 'file'
      ? [block]
      : []
}
export type ToolModelContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export function toolResultContent(
  block: Extract<ContentBlock, { type: 'tool-result' }>,
  resources: ReadonlyMap<string, ResolvedResource>,
): ToolModelContent[] {
  return [
    {
      type: 'text',
      text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
    },
    ...(block.images ?? []).map((image): ToolModelContent => {
      const resource = resources.get(image.resourceId)
      return resource
        ? { type: 'image', data: resource.data, mimeType: resource.mimeType }
        : { type: 'text', text: `图片附件：${image.filename}（当前模型不支持图像或图片不可用）` }
    }),
  ]
}
