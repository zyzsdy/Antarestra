import { imageSize } from 'image-size'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, GeneratedImage, ToolImage } from './types.js'
import { AiError, check } from './utils.js'

type Hosted = Extract<ContentBlock, { type: 'provider-tool' }>

/** 内置工具仍由提供商执行；这里只接收产物，不伪造客户端工具调用。 */
export class ProviderImages {
  private saved = new Map<string, Promise<ToolImage>>()
  private delivered = new Set<string>()

  constructor(private store: (image: GeneratedImage) => Promise<ToolImage>) {}

  async receive(block: Hosted, signal: AbortSignal): Promise<Hosted> {
    signal.throwIfAborted()
    if (block.result.type !== 'image_generation_call') return block
    const { result: encoded, ...metadata } = block.result
    // Base64 不进入运行历史、事件或下一轮文本上下文。
    if (block.status !== 'completed') return { ...block, result: metadata }
    let saved = this.saved.get(block.id)
    if (!saved) {
      saved = this.save(encoded, metadata.output_format, signal)
      this.saved.set(block.id, saved)
    }
    return { ...block, result: { ...metadata, image: { ...(await saved) } } }
  }

  take(content: ContentBlock[]): ToolImage[] {
    const images: ToolImage[] = []
    for (const block of content) {
      if (
        block.type !== 'provider-tool' ||
        !this.saved.has(block.id) ||
        this.delivered.has(block.id) ||
        block.status !== 'completed'
      )
        continue
      this.delivered.add(block.id)
      images.push(block.result.image as ToolImage)
    }
    return images
  }

  private async save(encoded: unknown, format: unknown, signal: AbortSignal): Promise<ToolImage> {
    check(
      typeof encoded === 'string' &&
        encoded.length > 0 &&
        encoded.length <= Math.ceil((8 * 1024 ** 2) / 3) * 4 &&
        encoded.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(encoded),
      '生成图片为空、Base64 无效或超过 8 MiB',
    )
    const data = Buffer.from(encoded, 'base64')
    check(data.toString('base64') === encoded, '生成图片 Base64 无效')
    let dimensions: ReturnType<typeof imageSize>
    try {
      dimensions = imageSize(data)
    } catch {
      throw new AiError('invalid_generated_image', '生成图片内容无法识别')
    }
    const type = dimensions.type === 'jpg' ? 'jpeg' : dimensions.type
    check(['png', 'jpeg', 'webp'].includes(type ?? ''), '生成图片格式不受支持')
    check(format === undefined || format === type, '生成图片内容与声明格式不符')
    return this.store({
      signal,
      data,
      mimeType: `image/${type}`,
      filename: `generated-${randomUUID()}.${type}`,
      width: dimensions.width,
      height: dimensions.height,
    })
  }
}
