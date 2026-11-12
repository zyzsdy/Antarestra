import { createModelDriver } from '@antarestra/ai-model-driver'
import type { ModelProviderConfig } from '@antarestra/ai-model-driver'
import { AiError } from '@antarestra/ai'
import { subscriptionPayload } from './codex-models.js'

export function codexDriver(provider: ModelProviderConfig, fetch = globalThis.fetch) {
  return createModelDriver(provider, {
    // 保留历史驱动标识，使重构前保存的续接签名继续有效；不代表依赖普通提供商插件。
    id: `ai-provider:${provider.id}`,
    fetch,
    transformPayload: subscriptionPayload,
    completionEvent: { type: 'response.completed', missingMessage: '订阅响应未完成，请重试' },
    validateFiles(files) {
      if (
        [...files.values()].some((resource) =>
          /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key)$/i.test(resource.filename),
        )
      )
        throw new AiError(
          'unsupported_subscription_file',
          'ChatGPT 订阅不支持 Files 上传，请转换为 PDF 或文本后重试',
        )
    },
  })
}
