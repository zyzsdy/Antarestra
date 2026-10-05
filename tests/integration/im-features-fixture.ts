import { randomUUID } from 'node:crypto'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import Server from '@antarestra/plugin-server'
import rbac from '@antarestra/rbac'
import im from '@antarestra/im'
import type {
  ChatTarget,
  ConnectionPolicy,
  IncomingMessage,
  MessageContext,
  MessageSegment,
  ConnectionDescriptor,
  Config as ImConfig,
} from '@antarestra/im'
import identityIm from '@antarestra/plugin-identity-im'
import commands from '@antarestra/plugin-im-commands'
import type { Config as CommandsConfig } from '@antarestra/plugin-im-commands'
import type { CommandPolicy } from '@antarestra/plugin-im-commands'
import ai from '@antarestra/ai'
import type { AgentPreset, ModelDriver } from '@antarestra/ai'
import * as agentCore from '@antarestra/plugin-ai-agent-core'
import imAi from '@antarestra/plugin-im-ai'
import { pluginId } from '../../plugins/features/im-ai/src/store.js'
import type { Tables } from '../../plugins/features/im-ai/src/store.js'

const contexts: Context[] = []
export async function allowCommand(ctx: Context, name: string, patch: Partial<CommandPolicy> = {}) {
  const current = await ctx.imCommands.getPolicy(name)
  await ctx.imCommands.setPolicy(
    name,
    {
      ...current.policy,
      group: { mode: 'blacklist', ids: [] },
      private: { mode: 'blacklist', ids: [] },
      ...patch,
    },
    current.revision,
  )
}
export async function cleanup() {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
}
export async function setup(
  options: {
    ai?: boolean
    commands?: Partial<CommandsConfig>
    /** 其他功能测试显式放行测试指令；权限专项关闭后验证生产默认值。 */
    allowCommands?: boolean
    imConfig?: ImConfig
    driver?: ModelDriver
    queueLimit?: number
    deliveryAttempts?: number
    modelInput?: ('text' | 'image' | 'file')[]
    contextWindow?: number
    userTemplate?: string
    systemTemplate?: string
    databaseFilename?: string
    toolIds?: string[]
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: options.databaseFilename ?? ':memory:' })
  await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rbac)
  // 无关延迟的功能测试立即投递；延迟专项测试显式传入配置（空对象使用默认值）。
  const imPlugin = await ctx.plugin(im, options.imConfig ?? { sendDelayPerCharMs: 0 })
  await ctx.plugin(identityIm)
  const commandPlugin = await ctx.plugin(commands, options.commands ?? {})
  const messages: MessageContext[] = []
  ctx.im.registerHandler(ctx, {
    id: 'capture',
    stage: 'message',
    handle: (message) => {
      messages.push(message)
    },
  })
  const sent: { connection: string; target: ChatTarget; segments: readonly MessageSegment[] }[] = []
  let sendError: Error | undefined
  const defaultPolicy: ConnectionPolicy = {
    group: { mode: 'whitelist', ids: ['40894918'], defaults: { ai: true, agentId: 'assistant' } },
    private: { mode: 'whitelist', ids: [] },
  }
  async function connect(
    id = 'qq-a',
    accountId = '05',
    policy = defaultPolicy,
    downloadMedia?: ConnectionDescriptor['downloadMedia'],
    getMember: NonNullable<ConnectionDescriptor['getMember']> = async () => ({ active: true }),
  ) {
    const handle = ctx.im.registerConnection(ctx, {
      id,
      accountId,
      platform: 'qq',
      ...(downloadMedia ? { downloadMedia } : {}),
      getMember,
      async send(target, segments) {
        if (sendError) throw sendError
        sent.push({ connection: id, target, segments })
        return { messageId: randomUUID() }
      },
    })
    if (ctx.im.getPolicyRevision(id) === 0) await ctx.im.setPolicy(id, policy)
    handle.setStatus('online')
    return {
      handle,
      receive(text: string, changes: Partial<IncomingMessage> = {}) {
        return handle.receive({
          id: randomUUID(),
          chat: { type: 'group', id: '40894918' },
          sender: { id: '79338528', name: '测试用户' },
          segments: [{ type: 'text', text }],
          ...changes,
        })
      },
    }
  }
  const connection = await connect()
  const aiState = { calls: 0 }
  let aiPlugin: Awaited<ReturnType<typeof ctx.plugin>> | undefined
  if (options.ai) {
    await ctx.plugin(ai, {})
    ctx.ai.registerProvider(ctx, {
      id: 'provider',
      title: '测试连接',
      baseUrl: 'https://example.invalid',
      driverId: 'driver',
      models: [
        {
          id: 'model',
          title: '测试模型',
          contextWindow: options.contextWindow ?? 10000,
          maxOutputTokens: 1000,
          input: options.modelInput ?? ['text'],
          output: ['text'],
          thinkingLevels: [],
          tools: true,
        },
      ],
    })
    ctx.ai.registerDriver(
      ctx,
      options.driver ?? {
        id: 'driver',
        async generate() {
          aiState.calls++
          return {
            content: [
              { type: 'thinking', text: '不可发送的思考' },
              { type: 'text', text: '最终回答' },
            ],
          }
        },
      },
    )
    await ctx.plugin(agentCore)
    const preset: AgentPreset = {
      id: 'assistant',
      version: '1',
      title: '测试助理',
      backendId: 'ai-agent-core',
      systemTemplate: options.systemTemplate ?? '系统',
      userTemplate: options.userTemplate ?? '{{input}}',
      models: [{ providerId: 'provider', modelId: 'model' }],
      defaultModel: { providerId: 'provider', modelId: 'model' },
      toolIds: options.toolIds ?? [],
      skillIds: [],
      extensions: {},
      contextPolicy: {
        compaction: {
          enabled: false,
          reserve: 1000,
          keepRecent: 1000,
          model: null,
          thinking: null,
        },
        trimming: { enabled: false, mode: 'rounds', rounds: 3, keepFirst: true },
      },
    }
    ctx.ai.registerAgent(ctx, preset)
    ctx.ai.registerAgent(ctx, { ...preset, id: 'second' })
    aiPlugin = await ctx.plugin(imAi, {
      pollIntervalMs: 20,
      queueLimit: options.queueLimit ?? 5,
      deliveryAttempts: options.deliveryAttempts ?? 2,
    })
  }
  if (options.allowCommands !== false) {
    for (const command of (await ctx.imCommands.listCommands()).commands) {
      if (command.revision === 0) await allowCommand(ctx, command.name)
    }
  }
  return {
    ctx,
    connection,
    connect,
    sent,
    messages,
    commandPlugin,
    imPlugin,
    aiPlugin,
    aiState,
    defaultPolicy,
    jobs: () =>
      ctx.database
        .scope<Tables>(ctx, pluginId)
        .selectFrom('jobs')
        .selectAll()
        .orderBy('created_at')
        .execute(),
    setSendError(error?: Error) {
      sendError = error
    },
  }
}
