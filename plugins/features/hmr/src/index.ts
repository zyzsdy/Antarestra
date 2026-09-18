import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { Context } from '@antarestra/plugin-sdk'
import { Hmr, TimerService, coordinateHmr } from '@antarestra/plugin-sdk/hmr'
import type {} from '@antarestra/config-loader'
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

export function resolveConfig(input: Config, baseDir: string): Hmr.Config {
  input = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
  const include = directories(input.include, ['plugins'], 'include')
  const exclude = directories(input.exclude, [], 'exclude')
  const excluded = exclude.map((directory) => resolve(baseDir, directory))
  return {
    base: pathToFileURL(resolve(baseDir) + sep).href,
    root: include
      .map((directory) => resolve(baseDir, directory))
      .filter(
        (directory) =>
          !excluded.some((parent) => {
            const path = relative(parent, directory)
            return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
          }),
      ),
    // 官方 ignored 使用 glob，转义目录中的特殊字符，避免把目录配置当成通配符。
    ignored: [
      '**/node_modules',
      String.raw`**\\node_modules`,
      ...exclude.flatMap((directory) => {
        const path = relative(baseDir, resolve(baseDir, directory)).split(sep).join('/')
        if (!path) return ['**']
        // 官方把 node:path.relative() 原样交给 picomatch；兼容 Windows 的反斜杠。
        const escaped = path.replace(/[!*?\[\]{}()]/g, '\\$&').replaceAll('/', String.raw`[/\\]`)
        return [escaped, `${escaped}${String.raw`[/\\]`}**`]
      }),
    ],
    debounce: 100,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (!ctx.loader.internal) {
    throw new Error('HMR 需要 Node 模块缓存访问权限，请使用 --expose-internals 启动服务端')
  }
  const baseUrl = ctx.loader.ctx.baseUrl
  if (!baseUrl) throw new Error('HMR 需要配置加载器提供项目根目录')
  const resolved = resolveConfig(config, fileURLToPath(new URL('.', baseUrl)))
  await ctx.plugin(TimerService)
  await ctx.plugin(Hmr, resolved)
  ctx.inject(['hmr', 'configManager'], (owner) => {
    owner.effect(() => coordinateHmr(owner.hmr, (action) => owner.configManager.exclusive(action)))
  })
  ctx.inject(['webui', 'server'], (web) => {
    const baseDir = fileURLToPath(new URL('.', baseUrl))
    applyWebHmr(
      web,
      resolved.root!.map((path) => resolve(baseDir, path)),
      directories(config.exclude, [], 'exclude').map((path) => resolve(baseDir, path)),
    )
  })
}
