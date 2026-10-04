import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@antarestra/plugin-sdk'
import DatabaseProvider from '@antarestra/database'
import * as database from '@antarestra/plugin-database-kysely'
import im, {
  connectionKey,
  type ConnectionPolicy,
  type IdentityInput,
  type IncomingMessage,
  type MessageContext,
  type ConnectionHandle,
} from '@antarestra/im'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
const policy: ConnectionPolicy = {
  group: { mode: 'whitelist', ids: ['40894918'] },
  private: { mode: 'whitelist', ids: ['fish'] },
  defaults: { ai: true },
}
const message = (id = 'm1', sender = 'fish'): IncomingMessage => ({
  id,
  chat: { type: 'group', id: '40894918' },
  sender: { id: sender },
  segments: [{ type: 'text', text: '/ping' }],
})
const identity = (input: IdentityInput) => ({
  actorId: `${connectionKey(input.connection)}:${input.message.sender.id}`,
  workspaceId: `${connectionKey(input.connection)}:${input.message.chat.type}:${input.message.chat.id}`,
  workspaceLabel: '测试空间',
})
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DatabaseProvider)
  await ctx.plugin(database, { filename: ':memory:' })
  const fiber = await ctx.plugin(im)
  ctx.im.registerIdentity(ctx, {
    resolve: async (input) => identity(input),
    validate: async () => true,
    background: async () => undefined,
  })
  return { ctx, fiber }
}

it('按持久化空间解析连接，禁用与卸载后拒绝访问，卸载取消并等待操作', async () => {
  const { ctx } = await setup()
  const owner = await ctx.plugin(() => {})
  let operationSignal: AbortSignal | undefined
  const descriptor = {
    id: 'onebot',
    platform: 'onebot11',
    accountId: '05',
    policy,
    capabilities: ['test.wait'],
    send: async () => ({}),
    invoke: async (
      _action: string,
      _target: unknown,
      _parameters: unknown,
      signal?: AbortSignal,
    ) => {
      operationSignal = signal
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true }),
      )
      return '已清理'
    },
  }
  const connection = ctx.im.registerConnection(owner.ctx, descriptor)
  await connection.receive(message())
  const workspaceId = identity({
    connection: { ...descriptor, status: 'online' },
    message: message(),
  }).workspaceId
  const target = await ctx.im.resolveTarget(workspaceId)
  expect(target).toEqual({ workspaceId, connectionId: 'onebot', chat: message().chat })
  await expect(ctx.im.resolveTarget('foreign')).rejects.toThrow('没有可用')
  await ctx.im.setPolicy('onebot', { ...policy, enabled: false })
  await expect(ctx.im.resolveTarget(workspaceId)).rejects.toThrow('禁用')
  await ctx.im.setPolicy('onebot', policy)
  const pending = ctx.im.invoke(target, 'test.wait', {})
  await expect.poll(() => operationSignal).toBeDefined()
  await owner.dispose()
  expect(operationSignal!.aborted).toBe(true)
  expect(await pending).toBe('已清理')
  await expect(ctx.im.resolveTarget(workspaceId)).rejects.toThrow('没有可用')
})

it('群成员共享空间，不同账号、接入实例和私聊分别隔离', async () => {
  const { ctx } = await setup(),
    received: MessageContext[] = []
  ctx.im.registerHandler(ctx, {
    id: 'collect',
    stage: 'message',
    handle: (context) => {
      received.push(context)
    },
  })
  const register = (id: string, accountId: string) =>
    ctx.im.registerConnection(ctx, {
      id,
      platform: 'qq',
      accountId,
      policy,
      send: async () => ({}),
    })
  const a = register('qq-a', '05'),
    b = register('qq-b', '06'),
    c = register('qq-c', '05')
  await a.receive(message('1', 'fish'))
  await a.receive(message('2', 'bird'))
  await b.receive(message('1'))
  await c.receive(message('1'))
  await a.receive({ ...message('3'), chat: { type: 'private', id: 'fish' } })
  expect(received[0]!.workspaceId).toBe(received[1]!.workspaceId)
  expect(received[0]!.actorId).not.toBe(received[1]!.actorId)
  expect(new Set(received.map((item) => item.workspaceId)).size).toBe(4)
})

it('默认拒绝、名单上限、命令先于AI执行，禁用命令不影响普通消息', async () => {
  const { ctx } = await setup(),
    calls: string[] = []
  ctx.im.registerHandler(ctx, {
    id: 'ai',
    stage: 'ai',
    handle: () => {
      calls.push('ai')
    },
  })
  ctx.im.registerHandler(ctx, {
    id: 'command',
    stage: 'command',
    handle: (context) => {
      if (context.policy.commands === false) return 'continue'
      calls.push('command')
      return 'consumed' as const
    },
  })
  const rejected = ctx.im.registerConnection(ctx, {
    id: 'closed',
    platform: 'qq',
    accountId: '05',
    send: async () => ({}),
  })
  expect(await rejected.receive(message())).toEqual({ status: 'ignored' })
  const handle = ctx.im.registerConnection(ctx, {
    id: 'qq',
    platform: 'qq',
    accountId: '05',
    policy,
    send: async () => ({}),
  })
  expect(await handle.receive({ ...message(), chat: { type: 'group', id: 'other' } })).toEqual({
    status: 'ignored',
  })
  await handle.receive(message())
  expect(calls).toEqual(['command'])
  await ctx.im.setPolicy(
    'qq',
    { group: { mode: 'blacklist', ids: [] }, defaults: { ai: true, commands: false } },
    0,
  )
  expect(await handle.receive({ ...message('2'), chat: { type: 'group', id: 'other' } })).toEqual({
    status: 'ignored',
  })
  await handle.receive(message('2'))
  expect(calls).toEqual(['command', 'ai'])
})

it('并发投递去重在卸载重装后仍有效，处理失败也不重复执行副作用', async () => {
  const { ctx, fiber } = await setup(),
    run = vi.fn()
  ctx.im.registerHandler(ctx, { id: 'effect', stage: 'message', handle: run })
  const descriptor = { id: 'qq', platform: 'qq', accountId: '05', policy, send: async () => ({}) }
  let handle = ctx.im.registerConnection(ctx, descriptor)
  expect(
    (await Promise.all([handle.receive(message()), handle.receive(message())]))
      .map((item) => item.status)
      .sort(),
  ).toEqual(['duplicate', 'processed'])
  expect(run).toHaveBeenCalledTimes(1)
  await fiber.dispose()
  await ctx.plugin(im)
  ctx.im.registerIdentity(ctx, {
    resolve: async (input) => identity(input),
    validate: async () => true,
    background: async () => undefined,
  })
  ctx.im.registerHandler(ctx, {
    id: 'effect',
    stage: 'message',
    handle: () => {
      throw new Error('业务失败')
    },
  })
  handle = ctx.im.registerConnection(ctx, descriptor)
  expect(await handle.receive(message())).toEqual({ status: 'duplicate' })
  await expect(handle.receive(message('failed'))).rejects.toThrow('业务失败')
  expect(await handle.receive(message('failed'))).toEqual({ status: 'duplicate' })
})

it('可信请求拒绝JSON伪造并在连接卸载或策略撤销后失效', async () => {
  const { ctx } = await setup()
  let context!: MessageContext, handle!: ConnectionHandle
  ctx.im.registerHandler(ctx, {
    id: 'collect',
    stage: 'message',
    handle: (value) => {
      context = value
    },
  })
  const owner = await ctx.plugin({
    inject: ['im'],
    apply(owner: Context) {
      handle = owner.im.registerConnection(owner, {
        id: 'qq',
        platform: 'qq',
        accountId: '05',
        policy,
        send: async () => ({}),
      })
    },
  })
  await handle.receive(message())
  expect(await ctx.im.authenticate(context.request)).toMatchObject({ actorId: context.actorId })
  expect(
    await ctx.im.authenticate({
      ...context.request,
      actorId: context.actorId,
      workspaceId: context.workspaceId,
    }),
  ).toBeUndefined()
  await ctx.im.setPolicy('qq', { ...policy, enabled: false })
  expect(await ctx.im.authenticate(context.request)).toBeUndefined()
  await ctx.im.setPolicy('qq', policy)
  await owner.dispose()
  expect(context.signal.aborted).toBe(true)
  expect(await ctx.im.authenticate(context.request)).toBeUndefined()
  await expect(handle.receive(message('2'))).rejects.toThrow()
})

it('出站空间和接入严格匹配，投递幂等并保守标记未知结果', async () => {
  const { ctx } = await setup(),
    send = vi.fn(async () => ({ messageId: 'sent' }))
  let context!: MessageContext
  ctx.im.registerHandler(ctx, {
    id: 'collect',
    stage: 'message',
    handle: (value) => {
      context = value
    },
  })
  const handle = ctx.im.registerConnection(ctx, {
    id: 'qq',
    platform: 'qq',
    accountId: '05',
    policy,
    send,
  })
  await handle.receive(message())
  const target = { connectionId: 'qq', chat: message().chat, workspaceId: context.workspaceId }
  await expect(
    ctx.im.send({ ...target, chat: { type: 'group', id: 'other' } }, []),
  ).rejects.toThrow('不属于')
  await expect(ctx.im.send({ ...target, workspaceId: 'forged' }, [])).rejects.toThrow('不属于')
  await expect(
    ctx.im.send(target, [{ type: 'reply', messageId: 'foreign' }]),
  ).rejects.toMatchObject({ code: 'foreign_message' })
  await Promise.all([
    ctx.im.send(target, [{ type: 'reply', messageId: message().id }], { idempotencyKey: 'reply' }),
    ctx.im.send(target, [], { idempotencyKey: 'reply' }),
  ])
  expect(send).toHaveBeenCalledTimes(1)
  send.mockRejectedValueOnce(new Error('超时'))
  await expect(ctx.im.send(target, [], { idempotencyKey: 'unknown' })).rejects.toMatchObject({
    code: 'delivery_unknown',
  })
  await expect(ctx.im.send(target, [], { idempotencyKey: 'unknown' })).rejects.toMatchObject({
    code: 'delivery_unknown',
  })
  expect(send).toHaveBeenCalledTimes(2)
  await ctx.im.setPolicy('qq', { ...policy, enabled: false })
  await expect(ctx.im.send(target, [])).rejects.toThrow('禁用')
})

it('策略持久化、校验格式，并发更新只有一个相同修订号获准', async () => {
  const { ctx, fiber } = await setup()
  const descriptor = { id: 'qq', platform: 'qq', accountId: '05', policy, send: async () => ({}) }
  ctx.im.registerConnection(ctx, descriptor)
  const results = await Promise.allSettled([
    ctx.im.setPolicy('qq', { ...policy, enabled: false }, 0),
    ctx.im.setPolicy('qq', policy, 0),
  ])
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult
  expect(rejected.reason).toMatchObject({ status: 409, code: 'revision_conflict' })
  await expect(
    ctx.im.setPolicy('qq', { group: { mode: 'invalid', ids: [] } } as unknown as ConnectionPolicy),
  ).rejects.toMatchObject({ status: 400 })
  expect(ctx.im.getPolicyRevision('qq')).toBe(1)
  await fiber.dispose()
  await ctx.plugin(im)
  ctx.im.registerConnection(ctx, descriptor)
  expect(ctx.im.getPolicyRevision('qq')).toBe(1)
  expect(ctx.im.getChatPolicy('qq', message().chat).enabled).toBe(false)
})

it('卸载处理器后回收且同名注册可恢复，后台身份需要在线验证成员', async () => {
  const { ctx } = await setup(),
    run = vi.fn()
  const handler = await ctx.plugin({
    inject: ['im'],
    apply(owner: Context) {
      owner.im.registerHandler(owner, { id: 'test', stage: 'message', handle: run })
    },
  })
  const handle = ctx.im.registerConnection(ctx, {
    id: 'qq',
    platform: 'qq',
    accountId: '05',
    policy,
    send: async () => ({}),
  })
  await handle.receive(message())
  await handler.dispose()
  await handle.receive(message('2'))
  expect(run).toHaveBeenCalledTimes(1)
  ctx.im.registerHandler(ctx, { id: 'test', stage: 'message', handle: run })
  await handle.receive(message('3'))
  expect(run).toHaveBeenCalledTimes(2)
  expect(await ctx.im.validateBackground('fake', 'fake')).toBeUndefined()
})

it('独立卸载处理器会取消并等待正在处理的普通消息', async () => {
  const { ctx } = await setup(),
    started = Promise.withResolvers<void>(),
    cleaned = Promise.withResolvers<void>()
  let finished = false
  const handler = await ctx.plugin({
    inject: ['im'],
    apply(owner: Context) {
      owner.im.registerHandler(owner, {
        id: 'waiting',
        stage: 'message',
        async handle(context) {
          started.resolve()
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          await cleaned.promise
          finished = true
          return 'consumed' as const
        },
      })
    },
  })
  const handle = ctx.im.registerConnection(ctx, {
    id: 'qq',
    platform: 'qq',
    accountId: '05',
    policy,
    send: async () => ({}),
  })
  const receive = handle.receive(message())
  await started.promise
  const dispose = handler.dispose()
  expect(finished).toBe(false)
  cleaned.resolve()
  await dispose
  await receive
  expect(finished).toBe(true)
})

it('连接卸载会取消并等待该连接的活动处理，不影响其他连接', async () => {
  const { ctx } = await setup(),
    started = Promise.withResolvers<void>()
  let handle!: ConnectionHandle,
    finished = false
  ctx.im.registerHandler(ctx, {
    id: 'waiting',
    stage: 'message',
    async handle(context) {
      if (context.connection.id !== 'first') return 'continue' as const
      started.resolve()
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      finished = true
      return 'consumed' as const
    },
  })
  const owner = await ctx.plugin({
    inject: ['im'],
    apply(owner: Context) {
      handle = owner.im.registerConnection(owner, {
        id: 'first',
        platform: 'qq',
        accountId: '05',
        policy,
        send: async () => ({}),
      })
    },
  })
  const second = ctx.im.registerConnection(ctx, {
    id: 'second',
    platform: 'qq',
    accountId: '06',
    policy,
    send: async () => ({}),
  })
  const result = handle.receive(message()).catch(() => undefined)
  await started.promise
  await owner.dispose()
  await result
  expect(finished).toBe(true)
  await expect(second.receive(message())).resolves.toEqual({ status: 'processed' })
})
