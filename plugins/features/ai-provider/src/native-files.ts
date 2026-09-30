import OpenAI, { toFile } from 'openai'
import { AiError } from '@antarestra/ai'
import type { ResolvedResource } from '@antarestra/ai'

/** Responses 的二进制办公文档通过 Files SDK 上传；PDF 可直接内联，不建立远端副本。 */
export async function nativeFiles(
  api: string,
  resources: ReadonlyMap<string, ResolvedResource>,
  connection: { baseUrl: string; credential: string | undefined },
  headers: Record<string, string | null>,
  signal: AbortSignal,
) {
  const ids = new Map<string, string>()
  let client: OpenAI | undefined
  async function dispose() {
    if (!client) return
    await Promise.allSettled(
      [...ids.values()].map((id) =>
        client!.files.delete(id, { signal: AbortSignal.timeout(5000) }),
      ),
    )
  }
  try {
    if (api === 'openai-responses') {
      for (const [resourceId, resource] of resources) {
        if (!/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key)$/i.test(resource.filename))
          continue
        client ??= new OpenAI({
          baseURL: connection.baseUrl,
          apiKey: connection.credential || 'unused',
          defaultHeaders: headers,
          maxRetries: 0,
        })
        const file = await client.files.create(
          {
            file: await toFile(Buffer.from(resource.data, 'base64'), resource.filename, {
              type: resource.mimeType,
            }),
            purpose: 'user_data',
            // 取消或进程中断导致无法立即删除时，远端副本仍会自动过期。
            expires_after: { anchor: 'created_at', seconds: 3600 },
          },
          { signal },
        )
        ids.set(resourceId, file.id)
      }
    }
    return { ids, dispose }
  } catch {
    await dispose()
    signal.throwIfAborted()
    throw new AiError(
      'attachment_upload_failed',
      '模型接口未能接收文档附件，请检查 Files API 支持或切换接口',
    )
  }
}
