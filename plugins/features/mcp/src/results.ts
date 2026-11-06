import { imageSize } from 'image-size'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { Context } from '@antarestra/plugin-sdk'
import type { Json, RunContext, StructuredToolResult, ToolImage } from '@antarestra/ai'

export async function toolResult(
  ctx: Context,
  result: CallToolResult,
  run: RunContext,
): Promise<StructuredToolResult> {
  const images: ToolImage[] = []
  const content: Json[] = []
  for (const block of result.content ?? []) {
    const image =
      block.type === 'image'
        ? block
        : block.type === 'resource' &&
            'blob' in block.resource &&
            block.resource.mimeType?.startsWith('image/')
          ? { data: block.resource.blob, mimeType: block.resource.mimeType }
          : undefined
    if (image && /^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)) {
      if (images.length >= 20 || image.data.length > 12 * 1024 ** 2)
        throw new Error('MCP 工具图片超过数量或大小限制')
      const data = Buffer.from(image.data, 'base64')
      const size = imageSize(data)
      images.push(
        await ctx.ai.storeToolImage(
          run,
          {
            data,
            mimeType: image.mimeType,
            filename: `mcp-${images.length + 1}.${image.mimeType.split('/')[1]}`,
            width: size.width,
            height: size.height,
            signal: run.signal,
          },
          false,
        ),
      )
      content.push({ type: 'image', filename: images.at(-1)!.filename })
    } else if (
      block.type === 'image' ||
      block.type === 'audio' ||
      (block.type === 'resource' && 'blob' in block.resource)
    ) {
      // 二进制内容不能作为大段 base64 注入模型文本上下文。
      content.push({ type: block.type, description: 'MCP 返回了当前不支持的二进制内容' })
    } else content.push(JSON.parse(JSON.stringify(block)) as Json)
  }
  return {
    content: {
      content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: JSON.parse(JSON.stringify(result.structuredContent)) as Json }),
    },
    ...(images.length ? { images } : {}),
    isError: result.isError === true,
  }
}
