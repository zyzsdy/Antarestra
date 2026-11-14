import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { Context } from '@antarestra/plugin-sdk'
import { Hmr, coordinateHmr } from '@antarestra/plugin-sdk/hmr'
import type {} from '@antarestra/config-loader'
import { watch } from 'chokidar'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { applyWebHmr } from './webui.js'

export interface Config {
  include?: string[]
  exclude?: string[]
}

export const name = 'hmr'
export const inject = ['loader']

function directories(value: unknown, fallback: string[], key: string): string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`HMR ${key} 必须是非空目录字符串组成的数组`)
  }
  return value as string[]
}

function within(parent: string, path: string): boolean {
  const suffix = relative(parent, path)
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
}

export function resolveConfig(input: Config, baseDir: string) {
  input = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  const excluded = directories(input.exclude, [], 'exclude').map((path) => resolve(baseDir, path))
  const roots = directories(input.include, ['plugins'], 'include')
    .map((path) => resolve(baseDir, path))
    .filter((path) => !excluded.some((parent) => within(parent, path)))
  const hmr: Hmr.Config = {
    base: pathToFileURL(resolve(baseDir) + sep).href,
    // 项目按字面目录监视，保留根目录之外的绝对路径与写入稳定检测。
    watch: { enabled: false, files: [], debounce: 100 },
  }
  return { roots, excluded, hmr }
}

function watchSources(ctx: Context, roots: string[], excluded: string[]): void {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<string>()
  let flushing = Promise.resolve()
  const watcher = watch(roots, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
    ignored: (path) =>
      path.split(/[\\/]/).includes('node_modules') ||
      excluded.some((parent) => within(parent, resolve(path))),
  })
  const flush = async () => {
    if (!active || !pending.size) return
    const paths = [...pending]
    pending.clear()
    try {
      const result = await ctx.hmr.reconcile(() => (active ? paths : []))
      // 导入失败的事务保留旧实例；下一次修改时连同失败根目录一起重试。
      for (const aborted of result.aborted) {
        const files = aborted.urls
          .filter((url) => url.startsWith('file:'))
          .map((url) => fileURLToPath(url))
        for (const path of paths) {
          if (files.some((file) => within(path, file))) pending.add(path)
        }
        ctx.logger.warn('源码重载失败，保留旧实例：%s', aborted.error)
      }
      for (const skipped of result.skipped)
        ctx.logger.warn(
          '源码变更需要重启才能应用：%s (%s)',
          skipped.urls.join('、'),
          skipped.reason,
        )
    } catch (error) {
      for (const path of paths) pending.add(path)
      if (active) ctx.logger.warn('源码重载失败：%s', error)
    }
  }
  watcher.on('error', (error) => ctx.logger.warn('源码监视失败：%s', error))
  watcher.on('change', (path) => {
    if (!active) return
    pending.add(resolve(path))
    clearTimeout(timer)
    timer = setTimeout(() => {
      flushing = flushing.then(flush)
    }, 100)
  })
  ctx.effect(() => async () => {
    active = false
    clearTimeout(timer)
    pending.clear()
    await watcher.close()
    // 不等待排在配置卸载之后的事务，避免和配置管理队列互相等待。
    // 已运行的事务由 coordinateHmr 等待结束；排队事务通过 active 检查跳过。
  })
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const baseUrl = ctx.loader.ctx.baseUrl
  if (!baseUrl) throw new Error('HMR 需要配置加载器提供项目根目录')
  const { roots, excluded, hmr } = resolveConfig(config, fileURLToPath(new URL('.', baseUrl)))
  await ctx.use(Hmr, hmr)
  ctx.inject(['hmr'], (owner) => {
    let exclusive = <T>(action: () => Promise<T>) => action()
    owner.inject(['configManager'], (manager) => {
      manager.effect(() => {
        exclusive = (action) => manager.configManager.exclusive(action)
        return () => {
          exclusive = (action) => action()
        }
      })
    })
    owner.effect(() => coordinateHmr(owner.hmr, (action) => exclusive(action)))
    watchSources(owner, roots, excluded)
  })
  ctx.inject(['webui', 'server'], (web) => applyWebHmr(web, roots, excluded))
}
