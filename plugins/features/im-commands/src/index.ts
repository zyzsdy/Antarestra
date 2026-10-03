import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { MessageContext } from '@antarestra/im'
import '@antarestra/rbac'

export interface Config {
  prefix: string
  builtins: boolean
}
export interface CommandContext extends MessageContext {
  readonly args: readonly string[]
  readonly rawArgs: string
}
export interface Command {
  name: string
  description: string
  usage?: string
  permission?: string
  minArgs?: number
  maxArgs?: number
  execute(context: CommandContext): Promise<string | void> | string | void
}
interface Entry {
  command: Command
  owner: Context
  abort: AbortController
  pending: Set<Promise<unknown>>
}
declare module '@antarestra/plugin-sdk' {
  interface Context {
    imCommands: ImCommandsService
  }
}

/** 支持单双引号和反斜线转义；不执行字符串中的任何代码。 */
export function parseArguments(input: string): string[] {
  const result: string[] = []
  let value = '',
    quote = '',
    escaped = false,
    started = false
  for (const char of input) {
    if (escaped) {
      value += char
      escaped = false
      started = true
    } else if (char === '\\') {
      escaped = true
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) result.push(value)
      value = ''
      started = false
    } else {
      value += char
      started = true
    }
  }
  if (quote || escaped) throw new Error('参数引号或转义未闭合')
  if (started) result.push(value)
  return result
}

export class ImCommandsService extends Service<Config> {
  private readonly entries = new Map<string, Entry>()
  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'imCommands')
    ctx.im.registerHandler(ctx, {
      id: 'im-commands',
      stage: 'command',
      handle: (message) => this.handle(message),
    })
    if (config.builtins) {
      this.register(ctx, {
        name: 'ping',
        description: '检查机器人连接',
        maxArgs: 0,
        execute: () => 'pong',
      })
      this.register(ctx, {
        name: 'help',
        description: '查看当前可用命令',
        maxArgs: 0,
        execute: async (message) => {
          const lines: string[] = []
          for (const { command } of this.entries.values()) {
            if (command.permission) {
              try {
                await ctx.rbac.authorizeRequest('im', message.request, command.permission)
              } catch {
                continue
              }
            }
            lines.push(
              `${config.prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}：${command.description}`,
            )
          }
          return lines.join('\n')
        },
      })
    }
  }
  register(owner: Context, command: Command) {
    this.ctx.fiber.assertActive()
    if (!/^[a-z][\w-]*$/.test(command.name)) throw new Error('命令名称无效')
    if (this.entries.has(command.name)) throw new Error(`命令重复：${command.name}`)
    if ((command.minArgs ?? 0) < 0 || (command.maxArgs ?? Infinity) < (command.minArgs ?? 0))
      throw new Error('命令参数数量无效')
    const entry: Entry = {
      command: Object.freeze({ ...command }),
      owner,
      abort: new AbortController(),
      pending: new Set(),
    }
    return owner.effect(() => {
      this.entries.set(command.name, entry)
      return async () => {
        if (this.entries.get(command.name) === entry) this.entries.delete(command.name)
        entry.abort.abort()
        await Promise.allSettled([...entry.pending])
      }
    })
  }
  private async handle(message: MessageContext) {
    const text = message.message.segments
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()
    if (!text.startsWith(this.config.prefix)) return 'continue' as const
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.slice(this.config.prefix.length))
    const entry = match?.[1] ? this.entries.get(match[1]) : undefined
    if (!entry) return 'continue' as const
    const current = this.ctx.im.getChatPolicy(message.connection.id, message.message.chat)
    if (!current.enabled || current.commands === false) return 'consumed' as const
    const run = this.execute(entry, message, match?.[2] ?? '')
    entry.pending.add(run)
    try {
      await run
    } finally {
      entry.pending.delete(run)
    }
    return 'consumed' as const
  }
  private async execute(entry: Entry, message: MessageContext, rawArgs: string) {
    const signal = AbortSignal.any([message.signal, entry.abort.signal])
    const { command } = entry
    let answer: string | void = undefined
    try {
      signal.throwIfAborted()
      entry.owner.fiber.assertActive()
      if (!(await this.ctx.im.authenticate(message.request))) return
      if (command.permission) {
        try {
          await this.ctx.rbac.authorizeRequest('im', message.request, command.permission)
        } catch {
          answer = '没有执行此命令的权限。'
        }
      }
      if (!answer) {
        let args: string[] | undefined
        try {
          args = parseArguments(rawArgs)
        } catch {
          answer = '参数引号或转义未闭合。'
        }
        if (args) {
          if (args.length < (command.minArgs ?? 0) || args.length > (command.maxArgs ?? Infinity))
            answer = `用法：${this.config.prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`
          else answer = await command.execute({ ...message, signal, args, rawArgs })
        }
      }
    } catch {
      if (!signal.aborted) answer = '命令执行失败，请稍后重试。'
    }
    if (answer && !signal.aborted) await message.reply([{ type: 'text', text: answer }])
  }
}

export default {
  name: '@antarestra/plugin-im-commands',
  inject: ['im', 'rbac'],
  async apply(ctx: Context, input: Partial<Config> = {}) {
    const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
    await ctx.plugin(ImCommandsService, config)
  },
}
