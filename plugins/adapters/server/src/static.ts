import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type Koa from 'koa'
import send from 'koa-send'

export interface StaticEntry {
  mountPath: string
  directory: string
}

function within(root: string, filename: string): boolean {
  const path = relative(root, filename)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(String(error.code))
  )
}

export async function serveStatic(
  ctx: Koa.Context,
  entries: readonly StaticEntry[],
): Promise<void> {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return
  let path: string
  try {
    path = decodeURIComponent(ctx.path)
  } catch {
    ctx.status = 400
    return
  }
  if (path === '/api' || path.startsWith('/api/')) return
  // 同时禁止 Windows 盘符、备用数据流、反斜杠和编码后的点路径。
  if (/[\\\0:]/.test(path) || path.split('/').some((part) => part.startsWith('.'))) return
  for (const entry of entries) {
    const { mountPath } = entry
    if (mountPath !== '/' && path !== mountPath && !path.startsWith(`${mountPath}/`)) continue
    const suffix = mountPath === '/' ? path.slice(1) : path.slice(mountPath.length + 1)
    try {
      const root = await realpath(entry.directory)
      let filename = resolve(root, suffix)
      if (!within(root, filename)) return
      filename = await realpath(filename)
      if (!within(root, filename)) return
      if ((await stat(filename)).isDirectory())
        filename = await realpath(resolve(filename, 'index.html'))
      if (!within(root, filename) || !(await stat(filename)).isFile()) return
      // 仅发送检查过的实际文件；关闭旁路压缩文件和自动目录补全。
      const selected = relative(root, filename).split(sep).map(encodeURIComponent).join('/')
      await send(ctx, selected, { root, hidden: false, gzip: false, brotli: false, format: false })
      return
    } catch (error) {
      if (missing(error)) continue
      throw error
    }
  }
}
