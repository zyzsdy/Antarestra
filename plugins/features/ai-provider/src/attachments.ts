import { randomUUID } from 'node:crypto'
import { AiError } from '@antarestra/ai'
import type { ResolvedResource } from '@antarestra/ai'

/** pi-ai 原生仅声明文本和图片；通过 SDK 的 onPayload 扩展各协议文档块。 */
export function filePayload(api: string, remoteIds: ReadonlyMap<string, string> = new Map()) {
  const files = new Map<string, Record<string, unknown>>()
  function placeholder(file: ResolvedResource, resourceId?: string) {
    const marker = `antarestra-attachment:${randomUUID()}`
    let block: Record<string, unknown>
    const remoteId = resourceId ? remoteIds.get(resourceId) : undefined
    if (remoteId) {
      block = { type: 'input_file', file_id: remoteId }
    } else if (['google-generative-ai', 'google-vertex'].includes(api)) {
      block = { inlineData: { mimeType: file.mimeType, data: file.data } }
    } else if (file.mimeType === 'application/pdf') {
      if (['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api))
        block = {
          type: 'input_file',
          filename: file.filename,
          file_data: `data:${file.mimeType};base64,${file.data}`,
        }
      else if (api === 'openai-completions')
        block = {
          type: 'file',
          file: { filename: file.filename, file_data: `data:${file.mimeType};base64,${file.data}` },
        }
      else if (api === 'anthropic-messages')
        block = {
          type: 'document',
          title: file.filename,
          source: { type: 'base64', media_type: file.mimeType, data: file.data },
        }
      else throw new AiError('unsupported_attachment', '此接口不支持 PDF 附件，请切换模型或接口')
    } else {
      // 其他协议以文本内容发送可解码的文档，不把任意二进制当作文本。
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.data, 'base64'))
      } catch {
        throw new AiError(
          'unsupported_attachment',
          '此接口不支持该二进制附件，请使用 PDF、UTF-8 文本或支持该类型的模型',
        )
      }
      if (text.includes('\0'))
        throw new AiError('unsupported_attachment', '此接口不支持该二进制附件')
      return { type: 'text' as const, text: `附件：${file.filename}\n${text}` }
    }
    files.set(marker, block)
    return { type: 'text' as const, text: marker }
  }
  function transform(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(transform)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (typeof object.text === 'string' && files.has(object.text)) return files.get(object.text)
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, transform(child)]))
  }
  return { placeholder, transform }
}
