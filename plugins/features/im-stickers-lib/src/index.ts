import type { Context } from '@antarestra/plugin-sdk'
import { defineDatabasePlugin } from '@antarestra/database'
import { AuthError, readJson } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/ai'
import '@antarestra/im'
import type { MediaSegment } from '@antarestra/im'
import '@antarestra/plugin-im-commands'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'
import { StickersService, maxImageBytes, metadata } from './service.js'
import { migrations, pluginId, libraryWorkspace } from './store.js'

export { StickersService } from './service.js'
export type { Sticker } from './store.js'
export default defineDatabasePlugin({
  name: pluginId,
  migrations,
  inject: ['workspaceFile', 'rbac'],
  async apply(ctx: Context) {
    ctx.rbac.registerPermission(ctx, 'admin.im.stickers.manage', '管理全局表情包库', ['admin'])
    const access = await ctx.workspaceFile.accessWorkspace(ctx, libraryWorkspace, '全局表情包库')
    await ctx.plugin(StickersService, access)
    ctx.inject(['imStickers', 'ai'], (ctx) => {
      ctx.ai.registerTemplateVariable(ctx, {
        id: 'im_stickers',
        description: '全局共享表情包列表，每行包含文件 ID、标题、文本描述和分类；空库返回空文本。',
        resolve: async (context) => {
          await ctx.ai.authorizeRunContext(context)
          return ctx.imStickers.run(() => ctx.imStickers.template(), context.signal)
        },
      })
    })
    ctx.inject(['imStickers', 'im', 'imCommands'], (ctx) => {
      ctx.imCommands.register(ctx, {
        name: 'sticker',
        access: 'bot-admin',
        description: '添加或删除全局共享表情包',
        usage: 'add 标题 [图片] | delete 标题',
        minArgs: 2,
        execute: (message) =>
          ctx.imStickers.run(async (signal) => {
            try {
              const action = message.args[0]
              const { title } = metadata({ title: message.args.slice(1).join(' ') })
              if (action === 'add') {
                const images = message.message.segments.filter(
                  (part): part is MediaSegment => part.type === 'image',
                )
                if (images.length !== 1)
                  return '请在同一条消息中附带一张图片：/sticker add 标题 [图片]'
                const image = await ctx.im.downloadMedia(
                  {
                    workspaceId: message.workspaceId,
                    connectionId: message.connection.id,
                    chat: message.message.chat,
                  },
                  message.message,
                  images[0]!,
                  signal,
                  maxImageBytes,
                )
                const sticker = await ctx.imStickers.add({ title }, image, signal)
                return `已添加全局表情包「${title}」，ID：${sticker.id}`
              }
              if (action === 'delete') {
                const sticker = await ctx.imStickers.byTitle(title)
                if (!sticker) return `未找到表情包「${title}」。`
                await ctx.imStickers.remove(sticker.id, sticker.revision)
                return `已删除全局表情包「${title}」。`
              }
              return '用法：/sticker add 标题 [图片] 或 /sticker delete 标题'
            } catch (error) {
              if (error instanceof AuthError) return error.message
              throw error
            }
          }, message.signal),
      })
    })
    ctx.inject(['imStickers', 'server'], (ctx) => {
      const route = (
        method: string,
        path: string,
        action: (http: HttpContext, signal: AbortSignal) => Promise<unknown>,
      ) =>
        ctx.server.route(
          ctx,
          method,
          '/im-stickers' + path,
          ctx.rbac.require('admin.console.view'),
          ctx.rbac.require('admin.im.stickers.manage'),
          async (http) => {
            http.set('Cache-Control', 'no-store')
            http.body = await ctx.imStickers.run((signal) => action(http, signal))
          },
        )
      route('GET', '', async () => ({ stickers: await ctx.imStickers.list() }))
      route('POST', '', async (http, signal) => {
        const input = await readJson(http, Math.ceil((maxImageBytes * 4) / 3) + 16384)
        if (
          typeof input.data !== 'string' ||
          Buffer.from(input.data, 'base64').toString('base64') !== input.data
        )
          throw new AuthError(400, '图片数据无效')
        return ctx.imStickers.add(
          input,
          {
            data: Buffer.from(input.data, 'base64'),
            mimeType: typeof input.mimeType === 'string' ? input.mimeType : '',
          },
          signal,
        )
      })
      route('PUT', '/:id', async (http) =>
        ctx.imStickers.update(String(http.params.id), await readJson(http)),
      )
      route('POST', '/:id/delete', async (http) =>
        ctx.imStickers.remove(String(http.params.id), (await readJson(http)).revision),
      )
      route('GET', '/:id/content', async (http) => {
        const url = await ctx.imStickers.content(String(http.params.id))
        http.status = 302
        http.set('Location', url)
        return ''
      })
    })
    ctx.inject(['webui'], (ctx) => {
      ctx.webui.addEntry(ctx, {
        id: 'im-stickers-lib',
        directory: fileURLToPath(new URL('../public/', import.meta.url)),
      })
    })
  },
})
