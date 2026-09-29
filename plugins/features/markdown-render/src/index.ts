import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

export const name = '@antarestra/plugin-markdown-render'
export const inject = ['webui']
export function apply(ctx: Context) {
  ctx.webui.addEntry(ctx, {
    id: 'markdown-render',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
  })
}
