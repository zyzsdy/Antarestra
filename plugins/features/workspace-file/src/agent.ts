import type { Context } from '@antarestra/plugin-sdk'
import type { RunContext } from '@antarestra/ai'
import { AuthError } from '@antarestra/rbac'
import type { FileAccess } from './service.js'
export const agentFiles = {
  inject: ['ai', 'workspaceFile', 'rbac'],
  apply(ctx: Context) {
    const requests = new WeakMap<object, RunContext>()
    async function withAccess<T>(context: RunContext, action: (access: FileAccess) => Promise<T>) {
      const token = {}
      requests.set(token, context)
      try {
        return await action(await ctx.workspaceFile.authorize('workspace-file-agent', token))
      } finally {
        requests.delete(token)
      }
    }
    ctx.rbac.registerRequestSource(ctx, 'workspace-file-agent', {
      id: 'workspace-file',
      async resolve(request) {
        if (!request || typeof request !== 'object') return
        const context = requests.get(request)
        if (!context || context.signal?.aborted) return
        const live = ctx.ai.running.get(context.runId)
        // 工具执行时签发的临时凭证，不接受外部构造的 RunContext 或模型参数。
        if (
          !live ||
          live.context.actorId !== context.actorId ||
          live.context.workspaceId !== context.workspaceId ||
          live.record.status !== 'running'
        )
          return
        return { actorId: context.actorId, workspaceId: context.workspaceId, roles: ['user'] }
      },
    })
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }
    ctx.ai.registerTool(ctx, {
      id: 'workspace_file_list',
      description: '列出当前工作空间目录，根目录为 /。文件路径仅在当前空间有效。',
      parameters: {
        ...parameters,
        properties: { ...parameters.properties, page: { type: 'integer', minimum: 1 } },
      },
      async execute(args, context) {
        return withAccess(context, (access) =>
          ctx.workspaceFile.list(access, args.path, typeof args.page === 'number' ? args.page : 1),
        )
      },
    })
    ctx.ai.registerTool(ctx, {
      id: 'workspace_file_read',
      description: '读取当前工作空间的 UTF-8 文本文件，最多 1 MiB。不适用于图片或二进制文件。',
      parameters,
      async execute(args, context) {
        const bytes = await withAccess(context, (access) =>
          ctx.workspaceFile.read(access, args.path),
        )
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          throw new AuthError(400, '文件不是 UTF-8 文本')
        }
        if (text.includes('\0')) throw new AuthError(400, '不支持读取二进制文件')
        return { path: String(args.path), text }
      },
    })
  },
}
