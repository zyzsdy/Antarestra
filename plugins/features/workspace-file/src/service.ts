import { randomUUID } from 'node:crypto'
import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { AuthError } from '@antarestra/rbac'
import type { UploadedPart } from '@antarestra/storage'
import { name, usage } from './store.js'
import type { Tables, Space, FileEntry } from './store.js'
import { filePath, sizeValue } from './validation.js'
export interface Config {
  backendId?: string
  defaultQuota?: number
  maxFileSize?: number
  uploadMinutes?: number
}
export interface FileAccess {
  readonly workspaceId: string
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    workspaceFile: WorkspaceFileService
  }
}
export class WorkspaceFileService extends Service<Config> {
  private accesses = new WeakMap<FileAccess, { source: string; request: unknown }>()
  private tasks = new Set<Promise<unknown>>()
  private active = true
  constructor(
    ctx: Context,
    private readonly options: Config = {},
  ) {
    super(ctx, 'workspaceFile')
    sizeValue(options.defaultQuota ?? 1024 ** 3)
    sizeValue(options.maxFileSize ?? 1024 ** 3, 4 * 1024 ** 3)
    if (
      !Number.isInteger(options.uploadMinutes ?? 30) ||
      (options.uploadMinutes ?? 30) < 1 ||
      (options.uploadMinutes ?? 30) > 60
    )
      throw new Error('上传有效期必须为 1–60 分钟')
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (!this.tasks.size) void this.track(this.sweep()).catch(() => {})
      }, 60_000)
      timer.unref()
      return async () => {
        this.active = false
        clearInterval(timer)
        await Promise.allSettled([...this.tasks])
      }
    })
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task)).catch(() => {})
    return task
  }
  private db() {
    if (!this.active) throw new AuthError(503, '文件服务已卸载')
    return this.ctx.database.scope<Tables>(this.ctx, name)
  }
  async authorize(source: string, request: unknown): Promise<FileAccess> {
    const identity = await this.ctx.rbac.authorizeRequest(source, request, 'workspace.file.use')
    if (!identity.actorId || !identity.workspaceId) throw new AuthError(401, '请先登录')
    const access = Object.freeze({ workspaceId: identity.workspaceId })
    this.accesses.set(access, { source, request })
    const label =
      identity.workspaceLabel ??
      `${source}·${(await this.ctx.rbac.principal(identity.actorId))?.display_name ?? identity.actorId}`
    const existing = await this.db()
      .selectFrom('spaces')
      .select('id')
      .where('id', '=', access.workspaceId)
      .executeTakeFirst()
    if (!existing || identity.workspaceLabel) await this.ensure(access.workspaceId, label)
    return access
  }
  private async verify(access: FileAccess) {
    this.db()
    const entry = this.accesses.get(access)
    if (!entry) throw new AuthError(403, '无效的工作空间授权')
    const current = await this.ctx.rbac.authorizeRequest(
      entry.source,
      entry.request,
      'workspace.file.use',
    )
    if (!current.actorId || current.workspaceId !== access.workspaceId)
      throw new AuthError(403, '空间授权已失效')
  }
  private async ensure(id: string, label: string) {
    if (!id || id.length > 200) throw new AuthError(400, '空间标识无效')
    const db = this.db()
    const existing = await db
      .selectFrom('spaces')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (existing) {
      if ((JSON.parse(existing.payload) as Space).label !== label)
        await this.mutate(id, (state) => {
          state.label = label
        })
      return
    }
    const space: Space = {
      label,
      quota: this.options.defaultQuota ?? 1024 ** 3,
      files: [],
      uploads: [],
      garbage: [],
    }
    try {
      await db
        .insertInto('spaces')
        .values({ id, revision: 0, payload: JSON.stringify(space) })
        .execute()
    } catch (error) {
      if (!(await db.selectFrom('spaces').select('id').where('id', '=', id).executeTakeFirst()))
        throw error
    }
  }
  private async snapshot(id: string) {
    const row = await this.db()
      .selectFrom('spaces')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new AuthError(404, '空间不存在')
    return { row, state: JSON.parse(row.payload) as Space }
  }
  /** CAS 在数据库层串行化一个空间的配额和目录变更，覆盖多进程竞争。回调不能执行外部副作用。 */
  private async mutate<T>(id: string, action: (space: Space, revision: number) => T): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const { row, state } = await this.snapshot(id)
      const result = action(state, row.revision)
      const update = await this.db()
        .updateTable('spaces')
        .set({ revision: row.revision + 1, payload: JSON.stringify(state) })
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .executeTakeFirst()
      if (Number(update.numUpdatedRows) === 1) return result
    }
    throw new AuthError(409, '空间正在被其他请求修改，请重试')
  }
  private available(state: Space, path: string) {
    if (
      state.files.some(
        (f) =>
          f.path === path ||
          (f.kind === 'file' && path.startsWith(f.path + '/')) ||
          f.path.startsWith(path + '/'),
      ) ||
      state.uploads.some(
        (u) =>
          u.status === 'pending' &&
          (u.path === path || path.startsWith(u.path + '/') || u.path.startsWith(path + '/')),
      )
    )
      throw new AuthError(409, '路径已存在或与文件冲突')
    if (state.files.length + state.uploads.length >= 10000)
      throw new AuthError(409, '空间目录条目已达上限')
  }
  async list(access: FileAccess, input: unknown = '/', page = 1) {
    await this.verify(access)
    const path = filePath(input, true)
    const { state } = await this.snapshot(access.workspaceId)
    const prefix = path === '/' ? '/' : path + '/'
    const children = new Map<
      string,
      { path: string; kind: 'file' | 'directory'; size: number; createdAt: number }
    >()
    for (const entry of state.files) {
      if (!entry.path.startsWith(prefix)) continue
      const suffix = entry.path.slice(prefix.length)
      const child = prefix + suffix.split('/')[0]!
      if (suffix.includes('/'))
        children.set(child, { path: child, kind: 'directory', size: 0, createdAt: 0 })
      else
        children.set(child, {
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          createdAt: entry.createdAt,
        })
    }
    const rows = [...children.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path, 'zh-CN'),
    )
    const current = Math.max(
      1,
      Math.min(Number.isSafeInteger(page) ? page : 1, Math.max(1, Math.ceil(rows.length / 50))),
    )
    return {
      path,
      ...usage(state),
      total: rows.length,
      page: current,
      entries: rows.slice((current - 1) * 50, current * 50),
    }
  }
  async begin(access: FileAccess, input: { path: unknown; size: unknown }) {
    await this.verify(access)
    const path = filePath(input.path)
    const size = sizeValue(input.size, this.options.maxFileSize ?? 1024 ** 3)
    const backendId = this.options.backendId ?? 's3'
    const backend = this.ctx.storage.backend(backendId)
    const blob = this.ctx.storage.allocate(
      size,
      Date.now() + (this.options.uploadMinutes ?? 30) * 60_000,
    )
    const id = randomUUID()
    await this.mutate(access.workspaceId, (state) => {
      this.available(state, path)
      const { used, reserved } = usage(state)
      if (state.quota === 0 || size > state.quota - used - reserved)
        throw new AuthError(413, '工作空间剩余配额不足')
      state.uploads.push({ id, path, backend: backendId, blob, status: 'pending' })
    })
    try {
      const initialized = await backend.begin(blob)
      await this.mutate(access.workspaceId, (state) => {
        state.uploads.find((u) => u.id === id)!.blob = initialized
      })
      const plan = await backend.plan(initialized)
      return { token: id, expiresAt: blob.expiresAt, plan }
    } catch (error) {
      await this.cancel(access, id)
      throw error
    }
  }
  async complete(access: FileAccess, token: string, parts: UploadedPart[]) {
    await this.verify(access)
    const { state } = await this.snapshot(access.workspaceId)
    const upload = state.uploads.find((u) => u.id === token)
    if (!upload) throw new AuthError(404, '上传记录不存在')
    if (upload.status === 'complete') return { path: upload.path }
    if (upload.status !== 'pending' || upload.blob.expiresAt <= Date.now())
      throw new AuthError(410, '上传已取消或过期')
    await this.ctx.storage.backend(upload.backend).complete(upload.blob, parts)
    await this.verify(access)
    await this.mutate(access.workspaceId, (state) => {
      const current = state.uploads.find((u) => u.id === token)
      if (current?.status === 'complete') return
      if (!current || current.status !== 'pending' || current.blob.expiresAt <= Date.now())
        throw new AuthError(410, '上传已取消或过期')
      state.files.push({
        path: upload.path,
        kind: 'file',
        size: upload.blob.size,
        backend: upload.backend,
        key: upload.blob.key,
        createdAt: Date.now(),
      })
      current.status = 'complete'
    })
    return { path: upload.path }
  }
  async cancel(access: FileAccess, token: string) {
    await this.verify(access)
    await this.mutate(access.workspaceId, (state) => {
      const upload = state.uploads.find((u) => u.id === token)
      if (!upload) throw new AuthError(404, '上传记录不存在')
      if (upload.status === 'complete') throw new AuthError(409, '文件已完成上传')
      upload.status = 'cancelled'
    })
    // 保留记录至凭证过期后清理，避免客户端重放 PUT 产生无人回收的临时对象。
    return { ok: true }
  }
  async mkdir(access: FileAccess, input: unknown) {
    await this.verify(access)
    const path = filePath(input)
    await this.mutate(access.workspaceId, (state) => {
      this.available(state, path)
      state.files.push({
        path,
        kind: 'directory',
        size: 0,
        createdAt: Date.now(),
        key: '',
        backend: '',
      })
    })
    return { path }
  }
  async move(access: FileAccess, input: unknown, target: unknown) {
    await this.verify(access)
    const path = filePath(input),
      to = filePath(target)
    if (to.startsWith(path + '/')) throw new AuthError(400, '不能移动到自身子目录')
    await this.mutate(access.workspaceId, (state) => {
      this.available(state, to)
      if (
        state.uploads.some(
          (u) => u.status === 'pending' && (u.path === path || u.path.startsWith(path + '/')),
        )
      )
        throw new AuthError(409, '目录中仍有上传任务')
      const entries = state.files.filter((f) => f.path === path || f.path.startsWith(path + '/'))
      if (!entries.length) throw new AuthError(404, '文件或目录不存在')
      for (const entry of entries) entry.path = to + entry.path.slice(path.length)
    })
    return { path: to }
  }
  async remove(access: FileAccess, input: unknown) {
    await this.verify(access)
    const path = filePath(input)
    await this.mutate(access.workspaceId, (state) => {
      if (
        state.files.some((f) => f.path.startsWith(path + '/')) ||
        state.uploads.some(
          (u) => u.status === 'pending' && (u.path === path || u.path.startsWith(path + '/')),
        )
      )
        throw new AuthError(409, '目录非空或仍有上传任务')
      const index = state.files.findIndex((f) => f.path === path)
      if (index < 0) throw new AuthError(404, '文件或目录不存在')
      const [entry] = state.files.splice(index, 1)
      if (entry!.key) state.garbage.push({ key: entry!.key, backend: entry!.backend })
    })
    return { ok: true }
  }
  private async file(access: FileAccess, input: unknown): Promise<FileEntry> {
    await this.verify(access)
    const path = filePath(input)
    const { state } = await this.snapshot(access.workspaceId)
    const file = state.files.find((f) => f.path === path && f.kind === 'file')
    if (!file) throw new AuthError(404, '文件不存在')
    return file
  }
  async download(access: FileAccess, path: unknown) {
    const file = await this.file(access, path)
    const encodedName = encodeURIComponent(file.path.split('/').at(-1)!).replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    return {
      url: await this.ctx.storage.backend(file.backend).download(file.key, {
        contentDisposition: `attachment; filename*=UTF-8''${encodedName}`,
      }),
      expiresIn: 60,
    }
  }
  async read(access: FileAccess, path: unknown, limit = 1024 * 1024) {
    const file = await this.file(access, path)
    if (file.size > sizeValue(limit, 16 * 1024 * 1024))
      throw new AuthError(413, '文件超过读取上限，请使用下载接口')
    return this.ctx.storage.backend(file.backend).read(file.key)
  }
  async spaces(page: number, search: string) {
    // 通过身份服务公开契约同步未使用过存储的本地空间，不跨插件读表。
    for (let offset = 0; ; offset += 100) {
      const values = await this.ctx.rbac.personalWorkspaces(offset, 100)
      for (const value of values) await this.ensure(value.id, value.label)
      if (values.length < 100) break
    }
    const rows = await this.db().selectFrom('spaces').selectAll().orderBy('id').execute()
    const values = rows
      .map((row) => {
        const state = JSON.parse(row.payload) as Space
        return { id: row.id, label: state.label, revision: row.revision, ...usage(state) }
      })
      .filter((row) => `${row.id} ${row.label}`.toLowerCase().includes(search.toLowerCase()))
    const current = Math.max(
      1,
      Math.min(Number.isSafeInteger(page) ? page : 1, Math.max(1, Math.ceil(values.length / 20))),
    )
    return {
      total: values.length,
      page: current,
      entries: values.slice((current - 1) * 20, current * 20),
    }
  }
  async quota(id: string, quota: unknown, revision: unknown) {
    const value = sizeValue(quota)
    await this.mutate(id, (state, current) => {
      if (revision !== current) throw new AuthError(409, '空间已变化，请刷新后重试')
      state.quota = value
    })
    return { ok: true }
  }
  async sweep() {
    for (let offset = 0; this.active; offset += 100) {
      const rows = await this.db()
        .selectFrom('spaces')
        .selectAll()
        .orderBy('id')
        .offset(offset)
        .limit(100)
        .execute()
      for (const row of rows) {
        const state = JSON.parse(row.payload) as Space
        for (const upload of state.uploads) {
          // 留出传输与时钟偏差缓冲；完成记录也在此回收临时对象。
          if (upload.blob.expiresAt + 60 * 60_000 > Date.now()) continue
          try {
            const backend = this.ctx.storage.backend(upload.backend)
            await backend.discard(upload.blob)
            if (upload.status !== 'complete') await backend.remove(upload.blob.key)
            await this.mutate(row.id, (state) => {
              state.uploads = state.uploads.filter((u) => u.id !== upload.id)
            })
          } catch {
            /* 保留记录，下轮重试；后端卸载不遗失回收任务。 */
          }
        }
        for (const item of state.garbage) {
          try {
            await this.ctx.storage.backend(item.backend).remove(item.key)
            await this.mutate(row.id, (state) => {
              state.garbage = state.garbage.filter(
                (g) => g.key !== item.key || g.backend !== item.backend,
              )
            })
          } catch {
            /* 保留任务重试。 */
          }
        }
      }
      if (rows.length < 100) return
    }
  }
}
