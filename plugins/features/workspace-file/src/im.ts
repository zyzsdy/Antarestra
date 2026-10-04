import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/im'
import { AuthError } from '@antarestra/rbac'

export const imFiles = {
  inject: ['im', 'workspaceFile'],
  apply(ctx: Context) {
    const service = ctx.workspaceFile
    ctx.im.registerImageResources(ctx, {
      async inspect(workspaceId, resourceId, signal) {
        signal.throwIfAborted()
        const access = await service.groupArchiveAccess(ctx, workspaceId, workspaceId)
        const { src: _src, ...resource } = await service.prepareImage(access, { resourceId })
        return resource
      },
      async resolve(workspaceId, resourceId, signal) {
        signal.throwIfAborted()
        const access = await service.groupArchiveAccess(ctx, workspaceId, workspaceId)
        return service.temporaryUrl(access, resourceId)
      },
    })
    ctx.im.registerMediaArchive(ctx, {
      async store(message, media, download, signal) {
        const access = await service.groupArchiveAccess(
          ctx,
          message.workspaceId,
          `${message.platform}·${message.message.chat.type === 'group' ? '群聊' : '私聊'}·${message.message.chatName || message.message.chat.id}`,
        )
        const existing = await service.findGroupArchive(access, media.id)
        const file =
          existing ??
          (await (async () => {
            const payload = await download(service.archiveMaxFileSize, signal)
            signal.throwIfAborted()
            if (message.message.chat.type === 'group')
              await service.reserveGroupArchive(access, payload.data.byteLength)
            // 平台文件名不能形成路径；归档来源跟随文件 ID，移动文件不逃过清理。
            const filename =
              payload.filename.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').slice(-180) || media.type
            return service.writeAttachment(
              access,
              {
                ...payload,
                filename,
                ...(message.message.chat.type === 'group'
                  ? {
                      groupArchive: {
                        id: media.id,
                        timestamp: message.message.timestamp ?? message.receivedAt,
                      },
                    }
                  : {}),
              },
              signal,
            )
          })())
        return {
          resourceId: file.id,
          mimeType: file.mimeType,
          filename: file.filename,
          size: file.size,
        }
      },
      retain: (workspaceId, policy) =>
        service.retainGroupArchive(
          ctx,
          workspaceId,
          policy.mediaRetentionDays ?? 7,
          policy.mediaMaxBytes ?? 0,
        ),
      async available(workspaceId, resourceId) {
        try {
          const access = await service.groupArchiveAccess(ctx, workspaceId, workspaceId)
          await service.resource(access, resourceId)
          return true
        } catch (error) {
          if (error instanceof AuthError && [404, 410].includes(error.status)) return false
          throw error
        }
      },
    })
  },
}
