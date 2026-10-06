import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Service } from '@antarestra/plugin-sdk'
import type { Context, Fiber } from '@antarestra/plugin-sdk'
import { Entry } from '@antarestra/plugin-sdk/loader'
import { resolveConfigEnvironment, validateConfig } from '@antarestra/plugin-sdk/schema'
import { parseDocument, visit } from 'yaml'
import { createInstanceId } from './config.js'
import type { PluginEntry } from './config.js'
import { discover, metadata } from './catalog.js'
import type { PluginMetadata } from './catalog.js'
import {
  environment,
  loaderSchema,
  ManagementError,
  readDocument,
  validateLayout,
  writeDocument,
} from './document.js'
import type { LoaderSettings, PanelLayout } from './document.js'
import type { Config } from './index.js'
import { logPluginLifecycle } from './logging.js'
import { PluginLoadFailure, reportLoadFailure } from './diagnostics.js'
import type { LoadStage } from './diagnostics.js'

export type InstanceState = 'disabled' | 'waiting' | 'loading' | 'active' | 'failed' | 'unloading'
interface Instance {
  entry: PluginEntry
  fiber?: Fiber
  tracked?: Entry
  error?: string
  blocked?: boolean
  timedOut?: boolean
  starting?: number
  info?: PluginMetadata
}
export interface Operation {
  id: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  saved: boolean
  message: string
}
export interface ManagerConfig extends Config {
  restart?: () => Promise<void>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    configManager: ConfigManager
  }
}
export class ConfigManager extends Service<ManagerConfig> {
  private readonly owner: Context
  private readonly track: ReturnType<typeof logPluginLifecycle>
  readonly generation = randomUUID()
  readonly instances = new Map<string, Instance>()
  private readonly operations = new Map<string, Operation>()
  private settings!: LoaderSettings
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private restarting = false
  private readonly disposing = new Set<Fiber>()
  private readonly cleanupErrors = new WeakSet<Fiber>()
  private readonly cleanups = new WeakMap<Instance, Promise<void>>()

  constructor(
    ctx: Context,
    private readonly options: ManagerConfig,
  ) {
    super(ctx, 'configManager')
    this.owner = ctx
    this.track = logPluginLifecycle(ctx)
    ctx.logger.exporter({
      export: (message) => {
        if (message.type !== 'error') return
        let fiber = message.fiber?.deref()
        while (fiber) {
          if (this.disposing.has(fiber)) {
            this.cleanupErrors.add(fiber)
            break
          }
          if (fiber.parent.fiber === fiber) break
          fiber = fiber.parent.fiber
        }
      },
    })
    ctx.on('internal/plugin', (fiber) => {
      const id = fiber.entry?.options.id
      const item = id ? this.instances.get(id) : undefined
      if (
        item &&
        fiber.uid &&
        fiber.entry === item.tracked &&
        fiber.parent.fiber === this.owner.fiber
      ) {
        item.fiber = fiber
        this.track(fiber, item.entry)
        item.starting = Date.now()
      }
    })
    const timer = setInterval(() => this.monitor(), 50)
    timer.unref()
    ctx.effect(() => () => {
      this.closing = true
      clearInterval(timer)
    })
  }

  async [Service.init]() {
    const file = await readDocument(this.options.filename)
    this.settings = file.settings
    for (const entry of file.entries) this.instances.set(entry.instanceId, { entry })
    const duplicates = await this.duplicates(file.entries)
    for (const entry of file.entries) {
      const item = this.instances.get(entry.instanceId)!
      if (duplicates.has(entry.instanceId)) {
        item.error = '插件未声明多实例支持，重复配置均不加载'
        continue
      }
      if (entry.enabled) await this.launch(item)
    }
    // 管理服务先就绪，面板本身才能注入它；实例初始化由监视器独立跟踪。
  }

  private async duplicates(entries: PluginEntry[]) {
    const groups = new Map<string, { ids: string[]; multiple: boolean }>()
    for (const entry of entries) {
      try {
        const info = await metadata(this.options.resolvePlugin, entry.pluginId)
        const group = groups.get(info.name) ?? { ids: [], multiple: info.multipleInstances }
        group.ids.push(entry.instanceId)
        groups.set(info.name, group)
      } catch {
        /* 包缺失由单实例记录。 */
      }
    }
    return new Set(
      [...groups.values()]
        .filter((group) => !group.multiple && group.ids.length > 1)
        .flatMap((group) => group.ids),
    )
  }

  private async prepared(entry: PluginEntry) {
    let stage: LoadStage = 'metadata'
    try {
      const info = await metadata(this.options.resolvePlugin, entry.pluginId)
      stage = 'environment'
      const value = resolveConfigEnvironment(
        entry.config,
        await environment(this.options.filename),
        info.schema,
      )
      stage = 'validation'
      const config = info.schema
        ? validateConfig<Record<string, unknown>>(info.schema, value)
        : (value as Record<string, unknown>)
      return { info, config }
    } catch (error) {
      throw reportLoadFailure(this.owner, entry, stage, error)
    }
  }

  private async launch(item: Instance) {
    if (item.blocked) throw new ManagementError(409, '资源清理未完成，请重启系统')
    delete item.error
    delete item.timedOut
    let stage: LoadStage = 'import'
    try {
      const { info, config } = await this.prepared(item.entry)
      item.info = info
      const plugin = await this.withTimeout(
        this.options.resolvePlugin(item.entry.pluginId),
        this.settings.initializationTimeoutMs,
        '插件模块导入超时',
      )
      stage = 'registration'
      let owner = this.owner
      if (this.options.resolvePlugin.resolveUrl) {
        const tracked = new Entry(this.owner.loader)
        tracked.parent = this.owner.loader.root
        tracked.options = {
          id: item.entry.instanceId,
          name: this.options.resolvePlugin.resolveUrl(item.entry.pluginId),
          config: structuredClone(config),
        }
        owner = this.owner.extend({ [Entry.key]: tracked, baseUrl: this.owner.loader.ctx.baseUrl })
        tracked.ctx = owner
        this.owner.loader.store[item.entry.instanceId] = tracked
        this.owner.loader.root.data.push(tracked.options)
        item.tracked = tracked
      }
      item.fiber = owner.plugin(plugin, structuredClone(config)).ctx.fiber
      this.track(item.fiber, item.entry)
      if (item.tracked) item.tracked.fiber = item.fiber
      void item.fiber.await().catch(() => {})
    } catch (error) {
      item.error = (
        error instanceof PluginLoadFailure
          ? error
          : reportLoadFailure(this.owner, item.entry, stage, error)
      ).message
    }
  }

  private state(item: Instance): InstanceState {
    if (item.blocked || item.error || item.timedOut)
      return item.entry.enabled || item.fiber ? 'failed' : 'disabled'
    if (!item.entry.enabled) return 'disabled'
    const state = item.fiber?.state
    if (state === 2) return 'active'
    if (state === 1) return 'loading'
    if (state === 5) return 'unloading'
    if (state === 0) return 'waiting'
    return 'failed'
  }
  private failure(item: Instance) {
    if (item.error) return item.error
    if (item.fiber?.state === 0) {
      const missing = Object.keys(item.fiber.inject).filter((name) => {
        const impl = item.fiber!.ctx.reflect._getImpl(name, true)
        return !impl || impl.fiber.state !== 2
      })
      return `服务依赖未就绪：${missing.join('、') || '存在无法满足的依赖关系'}；请检查提供者是否启用、启动失败或循环依赖`
    }
    return '插件初始化失败，请检查运行日志'
  }
  private monitor() {
    if (!this.settings || this.closing) return
    for (const item of this.instances.values()) {
      if (item.fiber?.state !== 1) {
        delete item.starting
        continue
      }
      item.starting ??= Date.now()
      if (!item.timedOut && Date.now() - item.starting >= this.settings.initializationTimeoutMs) {
        item.timedOut = true
        item.error = '初始化超时'
        void this.unload(item).catch(() => {})
      }
    }
  }
  private async withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new ManagementError(409, message), { code: 'ERR_PLUGIN_TIMEOUT' }),
              ),
            ms,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  private unload(item: Instance): Promise<void> {
    const pending = this.cleanups.get(item)
    if (pending) return pending
    const cleanup = this.disposeInstance(item).finally(() => this.cleanups.delete(item))
    this.cleanups.set(item, cleanup)
    return cleanup
  }
  private async disposeInstance(item: Instance) {
    if (item.blocked) throw new ManagementError(409, '资源清理未完成，请重启系统')
    try {
      if (item.fiber) {
        this.disposing.add(item.fiber)
        await this.withTimeout(
          item.fiber.dispose(),
          this.settings.disposalTimeoutMs,
          '资源清理超时，请重启系统',
        )
        if (this.cleanupErrors.has(item.fiber)) throw new Error('插件清理抛出异常')
        this.disposing.delete(item.fiber)
      }
      if (item.tracked) {
        if (this.owner.loader.store[item.entry.instanceId] === item.tracked)
          delete this.owner.loader.store[item.entry.instanceId]
        const data = this.owner.loader.root.data
        const index = data.indexOf(item.tracked.options)
        if (index >= 0) data.splice(index, 1)
      }
      delete item.fiber
      delete item.tracked
    } catch {
      if (item.fiber) this.disposing.delete(item.fiber)
      item.blocked = true
      item.error = '资源清理失败，请重启系统'
      throw new ManagementError(409, item.error)
    }
  }
  private async settle(item: Instance) {
    while (!this.closing && (item.fiber?.state === 1 || item.fiber?.state === 5))
      await new Promise((resolve) => setTimeout(resolve, 50))
    if (this.state(item) === 'failed')
      throw new ManagementError(409, item.error ?? '插件启动失败或依赖未就绪')
  }

  async snapshot() {
    const file = await readDocument(this.options.filename)
    const configured = new Map(file.entries.map((entry) => [entry.instanceId, entry]))
    const ids = new Set([...configured.keys(), ...this.instances.keys()])
    const titles = new Map<string, string>()
    await Promise.all(
      [
        ...new Set(
          [...ids].map((id) => (configured.get(id) ?? this.instances.get(id)!.entry).pluginId),
        ),
      ].map(async (pluginId) => {
        try {
          titles.set(pluginId, (await metadata(this.options.resolvePlugin, pluginId)).title)
        } catch {
          /* 包缺失或元数据无效时仍展示实例及状态。 */
        }
      }),
    )
    return {
      version: file.version,
      generation: this.generation,
      layout: file.layout,
      loader: file.settings,
      runningLoader: this.settings,
      instances: [...ids].map((id) => {
        const item = this.instances.get(id)
        const entry = configured.get(id)
        return {
          instanceId: id,
          pluginId: (entry ?? item!.entry).pluginId,
          title: titles.get((entry ?? item!.entry).pluginId) ?? '',
          enabled: entry?.enabled ?? false,
          status: item ? this.state(item) : 'disabled',
          error: item?.error ?? (item && this.state(item) === 'failed' ? this.failure(item) : ''),
          pending: !isDeepStrictEqual(entry, item?.entry),
          removed: !entry,
          alias: file.layout.instances[id]?.alias ?? '',
          group: file.layout.instances[id]?.group ?? '',
          order: file.layout.instances[id]?.order ?? 0,
        }
      }),
    }
  }
  async detail(id: string) {
    const file = await readDocument(this.options.filename)
    const entry =
      file.entries.find((entry) => entry.instanceId === id) ?? this.instances.get(id)?.entry
    if (!entry) throw new ManagementError(404, '插件实例不存在')
    let info: PluginMetadata | undefined
    try {
      info = await metadata(this.options.resolvePlugin, entry.pluginId)
    } catch {
      /* 失败实例仍可编辑。 */
    }
    const key = entry.enabled ? id : `~${id}`
    const node = file.document.getIn(['plugins', key], true)
    const draft = file.document.clone()
    draft.contents = node as typeof draft.contents
    visit(draft, {
      Collection(_key, node) {
        node.flow = node.items.length === 0
      },
    })
    const yaml = node ? draft.toString() : '{}'
    return { version: file.version, entry, yaml, info, impacts: this.impacts(id) }
  }
  impacts(id: string) {
    const target = this.instances.get(id)?.fiber
    if (!target) return []
    const affected = new Set<Fiber>([target])
    const descends = (fiber: Fiber, roots: Set<Fiber>) => {
      let current = fiber
      while (true) {
        if (roots.has(current)) return true
        if (current.parent.fiber === current) return false
        current = current.parent.fiber
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const item of this.instances.values()) {
        if (!item.fiber || affected.has(item.fiber)) continue
        if (
          Object.keys(item.fiber.inject).some((name) => {
            const impl = item.fiber!.ctx.reflect._getImpl(name, true)
            return impl && descends(impl.fiber, affected)
          })
        ) {
          affected.add(item.fiber)
          changed = true
        }
      }
    }
    return [...this.instances]
      .filter(([key, item]) => key !== id && item.fiber && affected.has(item.fiber))
      .map(([key]) => key)
  }
  catalog() {
    return discover(this.options.resolvePlugin)
  }
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await Promise.all([...this.instances.values()].map((item) => this.cleanups.get(item)))
      if (this.closing || [...this.instances.values()].some((item) => item.blocked))
        throw new ManagementError(409, '资源清理未完成，暂停源码重载直到重启')
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }
  operation(id: string) {
    const operation = this.operations.get(id)
    if (!operation) throw new ManagementError(404, '操作记录不存在，进程可能已经重启')
    return { ...operation, generation: this.generation }
  }
  enqueue(
    action: (operation: Operation) => Promise<void>,
    ready: Promise<void> = Promise.resolve(),
  ) {
    if (this.closing || this.restarting) throw new ManagementError(409, '系统正在关闭或重启')
    const operation: Operation = {
      id: randomUUID(),
      state: 'queued',
      saved: false,
      message: '等待执行',
    }
    this.operations.set(operation.id, operation)
    this.queue = this.queue
      .then(async () => {
        await ready
        operation.state = 'running'
        try {
          this.owner.fiber.assertActive()
          await action(operation)
          operation.state = 'completed'
          operation.message = '操作完成'
        } catch (error) {
          operation.state = 'failed'
          operation.message =
            error instanceof ManagementError ? error.message : '操作失败，请检查配置及服务依赖'
        }
        if (this.operations.size > 200) {
          const oldest = [...this.operations.values()].find((value) =>
            ['completed', 'failed'].includes(value.state),
          )
          if (oldest) this.operations.delete(oldest.id)
        }
      })
      .catch(() => {
        operation.state = 'failed'
        operation.message = '操作已中断'
      })
    return { ...operation, generation: this.generation }
  }
  async add(version: string, name: string, operation: Operation) {
    const info = (await this.catalog()).find((item) => item.name === name)
    if (!info) throw new ManagementError(400, '插件不在可添加的依赖包列表中')
    const file = await readDocument(this.options.filename)
    if (!info.multipleInstances)
      for (const entry of file.entries) {
        let current: PluginMetadata | undefined
        try {
          current = await metadata(this.options.resolvePlugin, entry.pluginId)
        } catch {
          /* 缺失包。 */
        }
        if (current?.name === info.name)
          throw new ManagementError(409, '此插件仅允许一份配置，禁用配置也占用名额')
      }
    let pluginId = info.name
    const alias = info.name.replace(/^(?:@antarestra\/(?:plugin-)?|antarestra-plugin-)/, '')
    if (alias && alias !== info.name) {
      try {
        // 短名称仍需命中原包，避免解析优先级导致同名插件被替换。
        if ((await metadata(this.options.resolvePlugin, alias)).name === info.name) pluginId = alias
      } catch {
        /* 无法解析短名称时保留完整包名。 */
      }
    }
    let id = info.multipleInstances ? createInstanceId(pluginId) : pluginId
    const occupied = (id: string) =>
      file.entries.some((entry) => entry.instanceId === id) || this.instances.has(id)
    if (info.multipleInstances) {
      while (occupied(id)) id = createInstanceId(pluginId)
    } else if (occupied(id)) {
      throw new ManagementError(409, '插件配置标识已被占用')
    }
    await writeDocument(this.options.filename, version, (document) =>
      document.setIn(['plugins', `~${id}`], {}),
    )
    operation.saved = true
    this.instances.set(id, {
      entry: { instanceId: id, pluginId, enabled: false, config: {} },
      info,
    })
  }
  async save(
    version: string,
    id: string,
    yaml: string,
    enabled: boolean,
    alias: string,
    operation: Operation,
  ) {
    if (alias.length > 120) throw new ManagementError(400, '别名不能超过 120 字')
    let config: unknown
    const parsed = parseDocument(yaml, { uniqueKeys: true })
    try {
      if (parsed.errors.length) throw new Error()
      config = parsed.toJS({ maxAliasCount: 0 })
    } catch {
      throw new ManagementError(400, '插件配置 YAML 无效或包含重复键、别名')
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new ManagementError(400, '插件配置必须是映射')
    const file = await readDocument(this.options.filename)
    const previous = file.entries.find((entry) => entry.instanceId === id)
    if (!previous) throw new ManagementError(404, '配置已移除，请刷新')
    const next: PluginEntry = { ...previous, enabled, config: config as Record<string, unknown> }
    if (enabled) {
      await this.prepared(next)
      if (
        (
          await this.duplicates(
            file.entries.map((entry) => (entry.instanceId === id ? next : entry)),
          )
        ).has(id)
      )
        throw new ManagementError(409, '插件未声明多实例支持，请先删除重复配置')
    }
    if (this.instances.get(id)?.blocked)
      throw new ManagementError(409, '资源清理未完成，请重启系统')
    await writeDocument(this.options.filename, version, (document) => {
      const oldKey = previous.enabled ? id : `~${id}`
      const newKey = enabled ? id : `~${id}`
      // 改键保持该条目在映射中的位置。
      const plugins = document.get('plugins', true)
      if (plugins && typeof plugins === 'object' && 'items' in plugins) {
        for (const pair of plugins.items as { key: unknown; value: unknown }[]) {
          if (String(pair.key) === oldKey) {
            pair.key = document.createNode(newKey)
            pair.value = parsed.contents
          }
        }
      }
      document.setIn(['pluginPanel', 'instances', id, 'alias'], alias)
    })
    operation.saved = true
    await this.applyEntry(next)
  }
  private async applyEntry(next: PluginEntry, force = false) {
    const old = this.instances.get(next.instanceId)
    if (!force && old && isDeepStrictEqual(old.entry, next) && this.state(old) !== 'failed') return
    if (old) await this.unload(old)
    const item: Instance = { entry: structuredClone(next) }
    this.instances.set(next.instanceId, item)
    if (next.enabled) {
      await this.launch(item)
      await this.settle(item)
    }
  }
  async remove(version: string, id: string, operation: Operation) {
    await writeDocument(this.options.filename, version, (document) => {
      document.deleteIn(['plugins', id])
      document.deleteIn(['plugins', `~${id}`])
      const metadataPath = ['pluginPanel', 'instances', id]
      if (document.hasIn(metadataPath)) document.deleteIn(metadataPath)
    })
    operation.saved = true
    const item = this.instances.get(id)
    if (item) await this.unload(item)
    this.instances.delete(id)
  }
  async applyDisk(version: string, id: string) {
    const file = await readDocument(this.options.filename)
    if (version !== file.version) throw new ManagementError(409, '配置已变化，请刷新')
    const next = file.entries.find((entry) => entry.instanceId === id)
    if (!next) {
      const item = this.instances.get(id)
      if (item) await this.unload(item)
      this.instances.delete(id)
      return
    }
    if ((await this.duplicates(file.entries)).has(id))
      throw new ManagementError(409, '插件存在重复配置')
    if (next.enabled) await this.prepared(next)
    await this.applyEntry(next, true)
  }
  async layout(version: string, value: PanelLayout, operation: Operation) {
    const layout = validateLayout(value)
    await writeDocument(this.options.filename, version, (document) =>
      document.set('pluginPanel', layout),
    )
    operation.saved = true
  }
  async loaderSettings(version: string, value: unknown, operation: Operation) {
    const settings = validateConfig<LoaderSettings>(loaderSchema, value)
    await writeDocument(this.options.filename, version, (document) =>
      document.set('loader', settings),
    )
    operation.saved = true
  }
  requestRestart(ready: Promise<void>) {
    if (!this.options.restart) throw new ManagementError(503, '当前启动入口不支持重启')
    if (this.restarting) throw new ManagementError(409, '重启已接受')
    this.restarting = true
    const callback = this.options.restart
    void this.queue
      .then(() => ready)
      .then(callback)
      .catch(() => {
        this.restarting = false
      })
    return { accepted: true, generation: this.generation }
  }
}
