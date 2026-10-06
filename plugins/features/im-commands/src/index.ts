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
import { CommandAliases, aliasMigration, aliasPolicyKey } from './aliases.js'
import type { CommandAlias } from './aliases.js'
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
  private readonly aliases = new Map<string, CommandAlias>()
  private readonly changingAliases = new Set<string>()
  private readonly aliasStore: CommandAliases
  private readonly invocations = new WeakMap<MessageContext, Pick<Command, 'name' | 'permission'>>()
  readonly admins: GroupAdmins
  private readonly policies: CommandPolicies
  constructor(
    ctx: Context,
    readonly config: Config & { aliases?: CommandAlias[] },
  ) {
    super(ctx, 'imCommands')
    this.policies = new CommandPolicies(ctx)
    this.aliasStore = new CommandAliases(ctx)
    for (const alias of config.aliases ?? []) this.aliases.set(alias.name, alias)
    this.admins = new GroupAdmins(
      ctx,
      async (message) =>
        !(await this.denial(
          this.invocations.get(message) ?? { name: 'admin', access: 'bot-admin' },
          message,
        )),
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
          for (const command of this.directory()) {
            if (command.alias && !command.alias.available) continue
            const { policy } = await this.getPolicy(command.name)
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
    if (
      this.entries.has(command.name) ||
      this.aliases.has(command.name) ||
      this.changingAliases.has(command.name)
    )
      throw new Error(`命令重复：${command.name}`)
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
  private command(
    name: string,
  ): Entry['command'] & { alias?: { id: string; target: string; available: boolean } } {
    this.ctx.fiber.assertActive()
    const alias = this.aliases.get(name)
    if (alias) {
      const target = this.entries.get(alias.target)?.command
      const forwarding = `${this.config.prefix}${alias.target}${alias.suffix}`
      return {
        name,
        description: `命令别名 → ${forwarding}`,
        ...(target?.permission ? { permission: target.permission } : {}),
        alias: { id: alias.id, target: forwarding, available: !!target },
      }
    }
    const entry = this.entries.get(name)
    if (!entry) throw new AuthError(404, '命令不存在或所属插件已卸载，请刷新列表')
    return entry.command
  }
  async getPolicy(name: string) {
    return this.policies.get(this.policyKey(name), this.command(name).access)
  }
  async setPolicy(name: string, input: unknown, expected: unknown) {
    this.command(name)
    return this.policies.set(this.policyKey(name), input, expected)
  }
  private policyKey(name: string) {
    const alias = this.aliases.get(name)
    return alias ? aliasPolicyKey(alias) : name
  }
  private directory() {
    return [...this.entries.keys(), ...this.aliases.keys()].map((name) => this.command(name))
  }
  async createAlias(input: unknown, forwarding: unknown) {
    this.ctx.fiber.assertActive()
    if (typeof input !== 'string' || typeof forwarding !== 'string')
      throw new AuthError(400, '请填写命令别名和转发到的命令与参数')
    const supplied = input.trim()
    const name = supplied.startsWith(this.config.prefix)
      ? supplied.slice(this.config.prefix.length)
      : supplied
    if (!/^[a-zA-Z0-9][\w-]*$/.test(name) || name.length > 200)
      throw new AuthError(
        400,
        '别名须以字母或数字开头，只能包含字母、数字、下划线和连字符，最多 200 字符',
      )
    if (this.entries.has(name) || this.aliases.has(name) || this.changingAliases.has(name))
      throw new AuthError(409, '命令或别名已存在，请使用其他名称')
    const text = forwarding.trimStart()
    if (!text.startsWith(this.config.prefix) || text.length > 8192)
      throw new AuthError(400, `目标命令须以 ${this.config.prefix} 开头，最多 8192 字符`)
    const match = /^(\S+)([\s\S]*)$/.exec(text.slice(this.config.prefix.length))
    const target = match?.[1]
    if (!target || !this.entries.has(target) || target === name)
      throw new AuthError(400, '目标必须是已注册的命令，不能转发到另一个别名')
    const suffix = match?.[2] ?? ''
    try {
      parseArguments(suffix)
    } catch {
      throw new AuthError(400, '目标参数引号或转义未闭合')
    }
    this.changingAliases.add(name)
    try {
      const alias = await this.aliasStore.create(name, target, suffix)
      this.aliases.set(name, alias)
      return { name, ...(await this.getPolicy(name)) }
    } finally {
      this.changingAliases.delete(name)
    }
  }
  async deleteAlias(name: string, expectedId: unknown) {
    const alias = this.aliases.get(name)
    if (!alias) throw new AuthError(404, '命令别名不存在，请刷新列表')
    if (expectedId !== alias.id || this.changingAliases.has(name))
      throw new AuthError(409, '命令别名已变化，请刷新列表')
    this.changingAliases.add(name)
    try {
      await this.aliasStore.remove(alias)
      this.aliases.delete(name)
    } finally {
      this.changingAliases.delete(name)
    }
  }
  async listCommands(offset = 0, search = '') {
    this.ctx.fiber.assertActive()
    const all = this.directory()
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
        ...(command.alias ? { alias: command.alias } : {}),
        ...(await this.getPolicy(command.name)),
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
    policy ??= (await this.policies.get(this.policyKey(command.name), command.access)).policy
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
      .trimStart()
    if (!text.startsWith(this.config.prefix)) return 'continue' as const
    const match = /^(\S+)([\s\S]*)$/.exec(text.slice(this.config.prefix.length))
    const name = match?.[1]
    if (!name) return 'continue' as const
    const alias = this.aliases.get(name)
    const entry = this.entries.get(alias?.target ?? name)
    if (alias && !entry) {
      if (!(await this.ctx.im.authenticate(message.request))) return 'consumed' as const
      if (!(await this.denial(this.command(name), message)))
        await message.reply([
          { type: 'text', text: '别名的目标命令不可用，请联系管理员检查所属插件。' },
        ])
      return 'consumed' as const
    }
    if (!entry) return 'continue' as const
    const suffix = `${alias?.suffix ?? ''}${match?.[2] ?? ''}`
    const forwarded = alias
      ? {
          ...message,
          message: {
            ...message.message,
            segments: [
              { type: 'text' as const, text: `${this.config.prefix}${alias.target}${suffix}` },
              ...message.message.segments.filter((part) => part.type !== 'text'),
            ],
          },
        }
      : message
    const run = this.execute(
      entry,
      forwarded,
      suffix.trimStart(),
      alias ? this.command(name) : entry.command,
      !!alias,
    )
    entry.pending.add(run)
    try {
      return await run
    } finally {
      entry.pending.delete(run)
    }
  }
  private async execute(
    entry: Entry,
    message: MessageContext,
    rawArgs: string,
    authority: Pick<Command, 'name' | 'access' | 'permission'>,
    forwarded: boolean,
  ) {
    const signal = AbortSignal.any([message.signal, entry.abort.signal])
    const command = entry.command
    let answer: string | void = undefined
    try {
      signal.throwIfAborted()
      entry.owner.fiber.assertActive()
      if (!(await this.ctx.im.authenticate(message.request))) return 'consumed' as const
      const denied = await this.denial(authority, { ...message, signal })
      if (denied === 'chat') return 'consumed' as const
      if (denied === 'access') answer = '仅当前群的 bot 管理员可执行此命令；群主自动拥有该权限。'
      if (denied === 'permission') answer = '没有执行此命令的权限。'
      if (!answer) {
        signal.throwIfAborted()
        // 由其他处理器执行的入口（例如 /ai）通过检查后继续分发。
        if (!command.execute)
          return forwarded
            ? { type: 'continue' as const, segments: message.message.segments }
            : ('continue' as const)
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
            const invocation = { ...message, signal, args, rawArgs }
            // /admin 的内部复核沿用当前入口权限；不允许其他业务命令借此提升权限。
            if (command.name === 'admin') this.invocations.set(invocation, authority)
            try {
              answer = await command.execute(invocation)
            } finally {
              this.invocations.delete(invocation)
            }
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
  migrations: [...migrations, policyMigration, aliasMigration],
  inject: ['im', 'rbac'],
  async apply(ctx: Context, input: Partial<Config> = {}) {
    const config = schemaConfig<Config>(new URL('../config.schema.json', import.meta.url), input)
    const aliases = await new CommandAliases(ctx).list()
    await ctx.plugin(ImCommandsService, { ...config, aliases })
  },
})
