import type { Context } from '@antarestra/plugin-sdk'
import type { RunContext } from '@antarestra/ai'
import { AuthError } from '@antarestra/rbac'
import { AiError } from '@antarestra/ai'
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
    ctx.ai.registerResources(ctx, {
      async validate(resource, context) {
        try {
          const file = await withAccess(context, (access) =>
            ctx.workspaceFile.resource(access, resource.resourceId),
          )
          if (file.mimeType !== resource.mimeType)
            throw new AiError('invalid_attachment', '附件类型与工作空间文件不一致')
          if (resource.type === 'image' && !/^image\/(png|jpeg|gif|webp)$/.test(file.mimeType))
            throw new AiError(
              'unsupported_attachment',
              '此图片格式不能直接发送给 AI，请改用 PNG、JPEG、GIF 或 WebP',
            )
        } catch (error) {
          if (error instanceof AuthError && error.status === 410)
            throw new AiError('attachment_expired', '附件文件已过期，请重新上传')
          throw error
        }
      },
      async resolve(resource, context) {
        try {
          const file = await withAccess(context, (access) =>
            ctx.workspaceFile.readResource(access, resource.resourceId),
          )
          return {
            filename: file.filename,
            mimeType: file.mimeType,
            data: Buffer.from(file.bytes).toString('base64'),
          }
        } catch (error) {
          if (error instanceof AuthError)
            throw new AiError('attachment_unavailable', error.message, error.status)
          throw error
        }
      },
    })
    ctx.on('ai/context', async (context, draft) => {
      const current = new Set(
        ctx.ai.running.get(context.runId)?.record.input.attachments?.map((file) => file.resourceId),
      )
      for (const message of draft.messages) {
        for (let i = 0; i < message.content.length; i++) {
          const block = message.content[i]!
          if ((block.type !== 'image' && block.type !== 'file') || current.has(block.resourceId))
            continue
          try {
            await withAccess(context, (access) =>
              ctx.workspaceFile.resource(access, block.resourceId),
            )
          } catch (error) {
            if (!(error instanceof AuthError) || error.status !== 410) throw error
            message.content[i] = {
              type: 'text',
              text: `附件：${block.filename ?? block.resourceId}（文件已过期）`,
            }
          }
        }
      }
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
