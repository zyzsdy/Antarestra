import { createModelDriver } from '@antarestra/ai-model-driver'
import type { ProviderRecord } from './types.js'
import type { BuiltinQuota } from './builtin-quota.js'
export { resolveModel, useBuiltinAdapter } from '@antarestra/ai-model-driver'

/** 普通提供商将自己的数据库额度策略注入共享驱动。 */
export function driver(provider: ProviderRecord, quota?: BuiltinQuota) {
  return createModelDriver(provider, {
    id: `ai-provider:${provider.id}`,
    ...(quota
      ? {
          reserveTools: (workspaceId: string, names: string[]) =>
            quota.reserve(provider, workspaceId, names),
        }
      : {}),
  })
}
