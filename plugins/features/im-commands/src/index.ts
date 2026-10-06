import { Service } from '@antarestra/plugin-sdk'
import type { Context } from '@antarestra/plugin-sdk'
import { schemaConfig } from '@antarestra/plugin-sdk/schema'
import type { MessageContext } from '@antarestra/im'
import '@antarestra/rbac'
import { AuthError } from '@antarestra/rbac'
import { defineDatabasePlugin } from '@antarestra/database'
import { GroupAdmins, migrations, pluginId } from './admins.js'
import { CommandPolicies, policyMigration } from './policies.js'
import type { CommandPolicy, CommandSummary } from './policies.js'
export type { CommandPolicy, CommandPolicyState, CommandSummary } from './policies.js'

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
  /** 默认授权级别，可由集中配置覆盖；bot-admin 仅在群聊中检查身份。 */
  access?: 'user' | 'bot-admin'
  description: string
  usage?: string
  permission?: string
  minArgs?: number
  maxArgs?: number
  execute(context: CommandContext): Promise<string | void> | string | void
}
interface Entry {
  command: Omit<Command, 'execute'> & { execute?: Command['execute'] }
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
  readonly admins: GroupAdmins
  private readonly policies: CommandPolicies
  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'imCommands')
    this.policies = new CommandPolicies(ctx)
    this.admins = new GroupAdmins(
      ctx,
      async (message) => !(await this.denial({ name: 'admin', access: 'bot-admin' }, message)),
    )
    ctx.im.registerHandler(ctx, {
      id: 'im-commands',
      stage: 'command',
      handle: (message) => this.handle(message),
    })
    this.register(ctx, {
      name: 'admin',
      access: 'bot-admin',
      description: '添加当前群的 bot 管理员',
      usage: 'add <id>',
      minArgs: 2,
      maxArgs: 2,
      execute: async (message) => {
        if (message.message.chat.type !== 'group') return '管理当前群的管理员仅可在群聊中使用。'
        if (message.args[0] !== 'add') return `用法：${config.prefix}admin add <id>`
        try {
          await this.admins.add(message, message.args[1]!)
          return `已将 ${message.args[1]} 设为当前群的 bot 管理员。`
        } catch (error) {
          if (error instanceof AuthError) return error.message
          throw error
        }
      },
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
          let administrator: Promise<boolean> | undefined
          for (const { command } of this.entries.values()) {
            const { policy } = await this.policies.get(command.name, command.access)
            if (
              await this.denial(
                command,
                message,
                () => (administrator ??= this.admins.allowed(message)),
                policy,
              )
            )
              continue
            lines.push(
              `${config.prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}：${command.description}${policy.access === 'bot-admin' ? '（bot 管理）' : ''}`,
            )
          }
          return lines.join('\n')
        },
      })
    }
  }
  register(owner: Context, command: Command) {
    return this.registerEntry(owner, command)
  }
  /** 注册由后续消息处理器执行的命令入口，仍统一校验权限并展示在控制台。 */
  registerTrigger(owner: Context, command: Omit<Command, 'execute' | 'minArgs' | 'maxArgs'>) {
    return this.registerEntry(owner, command)
  }
  private registerEntry(owner: Context, command: Entry['command']) {
    this.ctx.fiber.assertActive()
    if (!/^[a-z0-9][\w-]*$/.test(command.name) || command.name.length > 200)
      throw new Error('命令名称无效')
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
  private command(name: string) {
    this.ctx.fiber.assertActive()
    const entry = this.entries.get(name)
    if (!entry) throw new AuthError(404, '命令不存在或所属插件已卸载，请刷新列表')
    return entry.command
  }
  async getPolicy(name: string) {
    return this.policies.get(name, this.command(name).access)
  }
  async setPolicy(name: string, input: unknown, expected: unknown) {
    this.command(name)
    return this.policies.set(name, input, expected)
  }
  async listCommands(offset = 0, search = '') {
    this.ctx.fiber.assertActive()
    const all = [...this.entries.values()]
      .map(({ command }) => command)
      .filter((command) =>
        `${command.name} ${command.description}`.toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
    const start = Math.min(offset, Math.max(0, Math.ceil(all.length / 20) - 1) * 20)
    const commands: CommandSummary[] = await Promise.all(
      all.slice(start, start + 20).map(async (command) => ({
        name: command.name,
        description: command.description,
        ...(command.usage ? { usage: command.usage } : {}),
        ...(await this.policies.get(command.name, command.access)),
      })),
    )
    return { commands, total: all.length, offset: start, prefix: this.config.prefix }
  }
  private async denial(
    command: Pick<Command, 'name' | 'access' | 'permission'>,
    message: MessageContext,
    administrator = () => this.admins.allowed(message),
    policy?: CommandPolicy,
  ) {
    const chat = message.message.chat
    const current = this.ctx.im.getChatPolicy(message.connection.id, chat)
    policy ??= (await this.policies.get(command.name, command.access)).policy
    const list = policy[chat.type]
    if (
      !current.enabled ||
      current.commands === false ||
      (list.mode === 'whitelist' ? !list.ids.includes(chat.id) : list.ids.includes(chat.id))
    )
      return 'chat' as const
    if (chat.type === 'group' && policy.access === 'bot-admin' && !(await administrator()))
      return 'access' as const
    if (command.permission) {
      try {
        await this.ctx.rbac.authorizeRequest('im', message.request, command.permission)
      } catch {
        return 'permission' as const
      }
    }
  }
  private async handle(message: MessageContext) {
    const text = message.message.segments
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()
    if (!text.startsWith(this.config.prefix)) return 'continue' as const
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.slice(this.config.prefix.length))
    const name = match?.[1]
    if (!name) return 'continue' as const
    const entry = this.entries.get(name)
    if (!entry) return 'continue' as const
    const run = this.execute(entry, message, match?.[2] ?? '')
    entry.pending.add(run)
    try {
      return await run
    } finally {
      entry.pending.delete(run)
    }
  }
  private async execute(entry: Entry, message: MessageContext, rawArgs: string) {
    const signal = AbortSignal.any([message.signal, entry.abort.signal])
    const command = entry.command
    let answer: string | void = undefined
    try {
      signal.throwIfAborted()
      entry.owner.fiber.assertActive()
      if (!(await this.ctx.im.authenticate(message.request))) return 'consumed' as const
      const denied = await this.denial(command, { ...message, signal })
      if (denied === 'chat') return 'consumed' as const
      if (denied === 'access') answer = '仅当前群的 bot 管理员可执行此命令；群主自动拥有该权限。'
      if (denied === 'permission') answer = '没有执行此命令的权限。'
      if (!answer) {
        signal.throwIfAborted()
        // 由其他处理器执行的入口（例如 /ai）通过检查后继续分发。
        if (!command.execute) return 'continue' as const
        let args: string[] | undefined
        try {
          args = parseArguments(rawArgs)
        } catch {
          answer = '参数引号或转义未闭合。'
        }
        if (args) {
          if (args.length < (command.minArgs ?? 0) || args.length > (command.maxArgs ?? Infinity))
            answer = `用法：${this.config.prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`
          else {
            signal.throwIfAborted()
            entry.owner.fiber.assertActive()
            answer = await command.execute({ ...message, signal, args, rawArgs })
          }
        }
      }
    } catch {
      if (!signal.aborted) answer = '命令执行失败，请稍后重试。'
    }
    if (answer && !signal.aborted) await message.reply([{ type: 'text', text: answer }])
    return 'consumed' as const
  }
}

export default defineDatabasePlugin({
  name: pluginId,
  migrations: [...migrations, policyMigration],
  inject: ['im', 'rbac'],
  async apply(ctx: Context, input: Partial<Config> = {}) {
    const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
    await ctx.plugin(ImCommandsService, config)
  },
})
