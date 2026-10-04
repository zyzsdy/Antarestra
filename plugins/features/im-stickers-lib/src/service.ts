import { Service, type Context } from '@antarestra/plugin-sdk'
import { AuthError } from '@antarestra/rbac'
import { imageDimensions, type FileAccess } from '@antarestra/plugin-workspace-file'
import { pluginId, type Sticker, type Tables } from './store.js'

export const maxImageBytes = 8 * 1024 ** 2
export function metadata(input: Record<string, unknown>) {
  const field = (value: unknown, label: string, max: number, fallback?: string) => {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'string') throw new AuthError(400, `请填写${label}`)
    const result = value.normalize('NFC').trim()
    if (result.length > max || /[\x00-\x1f\x7f]/.test(result))
      throw new AuthError(400, `${label}不能包含换行或控制字符，且最多 ${max} 个字符`)
    if (!result && fallback === undefined) throw new AuthError(400, `请填写${label}`)
    return result || fallback || ''
  }
  return {
    title: field(input.title, '标题', 100),
    description: field(input.description, '文本描述', 1000, ''),
    category: field(input.category, '分类', 100, '未分类'),
  }
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AuthError(400, '修订号无效')
  return Number(value)
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    imStickers: StickersService
  }
}
export class StickersService extends Service<FileAccess> {
  private abort = new AbortController()
  private tasks = new Set<Promise<unknown>>()
  constructor(
    ctx: Context,
    private readonly access: FileAccess,
  ) {
    super(ctx, 'imStickers')
    ctx.workspaceFile.registerSharedResources(ctx, 'im-stickers-lib', async (id) =>
      (await this.get(id)) ? access : undefined,
    )
    ctx.effect(() => {
      const timer = setInterval(() => {
        void this.run(() => this.collect()).catch(() => {})
      }, 60_000)
      timer.unref()
      return async () => {
        clearInterval(timer)
        this.abort.abort()
        await Promise.allSettled([...this.tasks])
      }
    })
  }
  private db() {
    this.ctx.fiber.assertActive()
    return this.ctx.database.scope<Tables>(this.ctx, pluginId)
  }
  run<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(60_000),
      ...(signal ? [signal] : []),
    ])
    combined.throwIfAborted()
    const task = action(combined)
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => {})
    return task
  }
  list() {
    return this.db().selectFrom('stickers').selectAll().orderBy('title').execute()
  }
  get(id: string) {
    return this.db().selectFrom('stickers').selectAll().where('id', '=', id).executeTakeFirst()
  }
  byTitle(title: string) {
    return this.db()
      .selectFrom('stickers')
      .selectAll()
      .where('title', '=', title)
      .executeTakeFirst()
  }
  async template() {
    return (await this.list())
      .map(
        ({ id, title, description, category }) =>
          `ID: ${id} | 标题: ${JSON.stringify(title)} | 文本描述: ${JSON.stringify(description)} | 分类: ${JSON.stringify(category)}`,
      )
      .join('\n')
  }
  async add(
    input: Record<string, unknown>,
    image: { data: Uint8Array; mimeType: string },
    signal: AbortSignal,
  ) {
    const values = metadata(input)
    if (await this.byTitle(values.title)) throw new AuthError(409, '已有同名表情包，请使用其他标题')
    if (!/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType))
      throw new AuthError(400, '请选择 PNG、JPEG、GIF 或 WebP 图片')
    if (!image.data.length || image.data.length > maxImageBytes)
      throw new AuthError(413, '图片必须大于 0 字节且不超过 8 MiB')
    imageDimensions(image.data, image.mimeType)
    const file = await this.ctx.workspaceFile.writeAttachment(
      this.access,
      {
        ...image,
        filename: `sticker.${image.mimeType.slice(6)}`,
      },
      signal,
    )
    try {
      signal.throwIfAborted()
      const row: Sticker = { id: file.id, ...values, revision: 0 }
      await this.db().insertInto('stickers').values(row).execute()
      return row
    } catch (error) {
      // 发布失败的文件加入持久清理队列；后台重试存储故障。
      await this.db().insertInto('garbage').values({ id: file.id }).execute()
      await this.collect()
      if (await this.byTitle(values.title))
        throw new AuthError(409, '已有同名表情包，请使用其他标题')
      throw error
    }
  }
  async update(id: string, input: Record<string, unknown>) {
    const values = metadata(input),
      expected = revision(input.revision)
    const other = await this.byTitle(values.title)
    if (other && other.id !== id) throw new AuthError(409, '已有同名表情包，请使用其他标题')
    try {
      const result = await this.db()
        .updateTable('stickers')
        .set({ ...values, revision: expected + 1 })
        .where('id', '=', id)
        .where('revision', '=', expected)
        .executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1)
        throw new AuthError(409, '表情包已被修改或删除，请刷新后重试')
    } catch (error) {
      const duplicate = await this.byTitle(values.title)
      if (duplicate && duplicate.id !== id)
        throw new AuthError(409, '已有同名表情包，请使用其他标题')
      throw error
    }
    return { id, ...values, revision: expected + 1 }
  }
  async remove(id: string, expected: unknown) {
    const current = revision(expected)
    await this.db().transaction(async (db) => {
      const result = await db
        .deleteFrom('stickers')
        .where('id', '=', id)
        .where('revision', '=', current)
        .executeTakeFirst()
      if (Number(result.numDeletedRows) !== 1)
        throw new AuthError(409, '表情包已被修改或删除，请刷新后重试')
      await db.insertInto('garbage').values({ id }).execute()
    })
    await this.collect()
    return { ok: true }
  }
  async collect() {
    for (const row of await this.db().selectFrom('garbage').selectAll().execute()) {
      try {
        await this.ctx.workspaceFile.removeResource(this.access, row.id)
        await this.db().deleteFrom('garbage').where('id', '=', row.id).execute()
      } catch {
        /* 保留队列，下次重试；已撤销共享，不再出现在列表。 */
      }
    }
  }
  async content(id: string) {
    if (!(await this.get(id))) throw new AuthError(404, '表情包不存在')
    return this.ctx.workspaceFile.resourceDownload(this.access, id)
  }
}
