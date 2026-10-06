import type { Context } from '@antarestra/plugin-sdk'
import type { RunContext } from '@antarestra/ai'
import { AuthError } from '@antarestra/rbac'
import { AiError } from '@antarestra/ai'
import { imageDimensions } from './validation.js'
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
      async storeImage(image, context) {
        if (!ctx.ai.running.get(context.runId)?.ownsToolContext(context))
          throw new AiError('forbidden', '图片写入需要有效工具上下文', 403)
        const file = await withAccess(context, (access) =>
          ctx.workspaceFile.writeAttachment(
            access,
            image,
            image.signal ? AbortSignal.any([context.signal, image.signal]) : context.signal,
          ),
        )
        return {
          type: 'image',
          resourceId: file.id,
          mimeType: file.mimeType,
          filename: file.filename,
          size: file.size,
          width: image.width,
          height: image.height,
        }
      },
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
          if (block.type === 'tool-result' && block.images) {
            const images = []
            const unavailable: string[] = []
            for (const image of block.images) {
              try {
                await withAccess(context, (access) =>
                  ctx.workspaceFile.resource(access, image.resourceId),
                )
                images.push(image)
              } catch (error) {
                if (!(error instanceof AuthError) || ![404, 410].includes(error.status)) throw error
                unavailable.push(`图片附件：${image.filename}（文件已过期或删除）`)
              }
            }
            block.images = images
            if (unavailable.length)
              block.content = { result: block.content, unavailableImages: unavailable }
          }
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
      properties: {
        path: { type: 'string', description: '当前工作空间内的目录路径，根目录填 /。' },
      },
      required: ['path'],
      additionalProperties: false,
    }
    ctx.ai.registerTool(ctx, {
      id: 'im_prepare_image',
      description:
        '准备要在 IM 回复中发送的工作空间图片或共享表情包。resourceId 和 path 只填一个；共享图片必须用 resourceId。将返回的 src 原样写入回复的 <image>src</image> 或 <sticker>src</sticker>。本工具只准备图片，发送需通过最终回复完成。支持 PNG、JPEG、GIF、WebP，最多 8 MiB。',
      parameters: {
        type: 'object',
        properties: {
          resourceId: {
            type: 'string',
            minLength: 1,
            description: '来自当前空间附件、工具结果、历史消息或共享表情包列表的真实图片资源 ID。',
          },
          path: {
            type: 'string',
            minLength: 1,
            description: '当前工作空间内的图片文件路径，可从 workspace_file_list 获取。',
          },
        },
        oneOf: [{ required: ['resourceId'] }, { required: ['path'] }],
        additionalProperties: false,
      },
      async execute(args, context) {
        if (!ctx.ai.running.get(context.runId)?.ownsToolContext(context))
          throw new AiError('forbidden', '准备图片需要有效工具上下文', 403)
        return withAccess(context, (access) =>
          ctx.workspaceFile.prepareImage(access, {
            ...(typeof args.resourceId === 'string' ? { resourceId: args.resourceId } : {}),
            ...(typeof args.path === 'string' ? { path: args.path } : {}),
          }),
        )
      },
    })
    ctx.ai.registerTool(ctx, {
      id: 'workspace_file_list',
      description:
        '浏览当前工作空间目录，返回直接子目录和文件的路径、类型及大小。根目录填 /；每页最多 50 项，按返回的 page 和 total 判断是否继续翻页。需要查看子目录时，再用其 path 调用本工具。这里的路径用于工作空间文件工具，与 bash、read 等工具的共享远端文件路径不同。',
      parameters: {
        ...parameters,
        properties: {
          ...parameters.properties,
          page: { type: 'integer', minimum: 1, description: '页码，从 1 开始，默认 1。' },
        },
      },
      async execute(args, context) {
        return withAccess(context, (access) =>
          ctx.workspaceFile.list(access, args.path, typeof args.page === 'number' ? args.page : 1),
        )
      },
    })
    ctx.ai.registerTool(ctx, {
      id: 'workspace_file_read',
      description:
        '读取当前工作空间的文本或查看图片。path 和 resourceId 只填一个：path 仅用于 UTF-8 文本；resourceId 可用于文本或图片，包括 IM 消息中 [图片,ID] 的资源 ID。文本最多 1 MiB；图片支持 PNG、JPEG、GIF、WebP，最多 8 MiB，需模型支持图片输入。此工具不能读取 bash 等工具使用的共享远端文件；远端文件使用 read。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description: '当前工作空间内的 UTF-8 文本文件路径，可从 workspace_file_list 获取。',
          },
          resourceId: {
            type: 'string',
            minLength: 1,
            description: '附件、工具结果或历史消息中的资源 ID；查看图片时使用此参数。',
          },
        },
        oneOf: [{ required: ['path'] }, { required: ['resourceId'] }],
        additionalProperties: false,
      },
      resultMode: 'structured',
      async execute(args, context) {
        try {
          return await withAccess(context, async (access) => {
            const resourceId = typeof args.resourceId === 'string' ? args.resourceId : undefined
            const resource = resourceId
              ? await ctx.workspaceFile.resource(access, resourceId)
              : undefined
            const isImage = resource?.mimeType.startsWith('image/') ?? false
            if (isImage && !/^image\/(png|jpeg|gif|webp)$/.test(resource!.mimeType))
              throw new AuthError(400, '图片只支持 PNG、JPEG、GIF 或 WebP')
            const limit = (isImage ? 8 : 1) * 1024 ** 2
            if (resource && resource.size > limit)
              throw new AuthError(
                413,
                isImage ? '图片超过 8 MiB 读取上限' : '文本超过 1 MiB 读取上限',
              )
            const bytes = resource
              ? (await ctx.workspaceFile.readResource(access, resource.id, limit)).bytes
              : await ctx.workspaceFile.read(access, args.path)
            if (isImage && resource) {
              const dimensions = imageDimensions(bytes, resource.mimeType)
              return {
                content: {
                  resourceId: resource.id,
                  path: resource.path,
                  filename: resource.filename,
                },
                images: [
                  {
                    type: 'image' as const,
                    resourceId: resource.id,
                    mimeType: resource.mimeType,
                    filename: resource.filename,
                    size: resource.size,
                    width: dimensions.width,
                    height: dimensions.height,
                  },
                ],
              }
            }
            let text: string
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
              throw new AuthError(400, '文件不是 UTF-8 文本')
            }
            if (text.includes('\0')) throw new AuthError(400, '不支持读取二进制文件')
            return {
              content: {
                path: resource?.path ?? String(args.path),
                ...(resource ? { resourceId: resource.id } : {}),
                text,
              },
            }
          })
        } catch (error) {
          if (!(error instanceof AuthError)) throw error
          return { content: { error: error.message }, isError: true }
        }
      },
    })
  },
}
