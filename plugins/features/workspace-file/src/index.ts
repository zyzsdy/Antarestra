import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import { defineDatabasePlugin } from '@antarestra/database'
import { AuthError, readJson, textField } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import type { UploadedPart } from '@antarestra/storage'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'
import { name, migrations } from './store.js'
import { WorkspaceFileService } from './service.js'
import type { Config, FileAccess } from './service.js'
import { agentFiles } from './agent.js'
import { imFiles } from './im.js'
export { WorkspaceFileService } from './service.js'
export type { Config, FileAccess } from './service.js'
export default defineDatabasePlugin({
  name,
  migrations,
  inject: ['storage', 'rbac', 'server'],
  async apply(ctx: Context, config: Config = {}) {
    config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), config)
    ctx.rbac.registerPermission(ctx, 'workspace.file.use', '使用工作空间文件', ['user', 'admin'])
    ctx.rbac.registerPermission(ctx, 'admin.storage.manage', '管理工作空间存储配额', ['admin'])
    await ctx.plugin(WorkspaceFileService, config)
    await ctx.plugin(agentFiles)
    await ctx.plugin(imFiles)
    await ctx.plugin({
      inject: ['workspaceFile'],
      apply(ctx: Context) {
        const service = ctx.workspaceFile
        const route = (
          method: string,
          path: string,
          action: (http: HttpContext, access: FileAccess) => Promise<unknown>,
        ) => {
          ctx.server.route(ctx, method, '/workspace-files' + path, async (http) => {
            http.set('Cache-Control', 'no-store')
            const access = await service.authorize('web', http)
            if (
              http.query.workspaceId !== undefined &&
              http.query.workspaceId !== access.workspaceId
            )
              throw new AuthError(403, '不能访问其他工作空间')
            try {
              http.body = await action(http, access)
            } catch (error) {
              if (error instanceof AuthError) throw error
              throw new AuthError(503, '存储操作失败，请检查存储服务或稍后重试')
            }
          })
        }
        route('GET', '', (http, access) =>
          service.list(access, http.query.path ?? '/', Number(http.query.page ?? 1)),
        )
        route('POST', '/uploads', async (http, access) => {
          const input = await readJson(http)
          if (input.workspaceId !== undefined && input.workspaceId !== access.workspaceId)
            throw new AuthError(403, '不能访问其他工作空间')
          return service.begin(access, {
            path: input.path,
            size: input.size,
            attachment: input.attachment === true,
            mimeType: input.mimeType,
          })
        })
        route('POST', '/uploads/:token/complete', async (http, access) => {
          const body = await readJson(http, 2 * 1024 * 1024)
          if (
            !Array.isArray(body.parts) ||
            body.parts.length > 10000 ||
            body.parts.some(
              (p) =>
                !p ||
                typeof p !== 'object' ||
                !Number.isSafeInteger(p.number) ||
                typeof p.etag !== 'string' ||
                p.etag.length > 200,
            )
          )
            throw new AuthError(400, '分片清单无效')
          return service.complete(
            access,
            textField(http.params.token, '上传凭证'),
            body.parts as UploadedPart[],
          )
        })
        route('POST', '/uploads/:token/cancel', async (http, access) => {
          await readJson(http)
          return service.cancel(access, textField(http.params.token, '上传凭证'))
        })
        route('POST', '/directories', async (http, access) =>
          service.mkdir(access, (await readJson(http)).path),
        )
        route('POST', '/move', async (http, access) => {
          const body = await readJson(http)
          return service.move(access, body.path, body.to)
        })
        route('POST', '/remove', async (http, access) =>
          service.remove(access, (await readJson(http)).path),
        )
        route('GET', '/download', (http, access) => service.download(access, http.query.path))
        route('GET', '/resources/:id', (http, access) =>
          service.resource(access, textField(http.params.id, '文件标识')),
        )
        route('POST', '/resources/:id/temporary-url', (http, access) =>
          service.temporaryUrl(access, textField(http.params.id, '文件标识')),
        )
        route('POST', '/resources/:id/remove', async (http, access) => {
          await readJson(http)
          return service.removeResource(access, textField(http.params.id, '文件标识'))
        })
        route('GET', '/resources/:id/content', async (http, access) => {
          const url = await service.resourceDownload(
            access,
            textField(http.params.id, '文件标识'),
            http.query.download === '1',
          )
          http.status = 302
          http.set('Location', url)
          return ''
        })
        const admin = (
          method: string,
          path: string,
          action: (http: HttpContext) => Promise<unknown>,
        ) =>
          ctx.server.route(
            ctx,
            method,
            '/workspace-file-admin' + path,
            ctx.rbac.require('admin.console.view'),
            ctx.rbac.require('admin.storage.manage'),
            async (http) => {
              http.set('Cache-Control', 'no-store')
              http.body = await action(http)
            },
          )
        admin('GET', '', (http) =>
          service.spaces(
            Number(http.query.page ?? 1),
            String(http.query.search ?? '').slice(0, 200),
          ),
        )
        admin('PUT', '/quota', async (http) => {
          const body = await readJson(http)
          return service.quota(
            textField(body.workspaceId, '空间标识', 200),
            body.quota,
            body.revision,
          )
        })
      },
    })
    await ctx.plugin({
      inject: ['webui', 'workspaceFile'],
      apply(ctx: Context) {
        ctx.webui.addEntry(ctx, {
          id: 'workspace-file',
          directory: fileURLToPath(new URL('../public/', import.meta.url)),
        })
      },
    })
  },
})
