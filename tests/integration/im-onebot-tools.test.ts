import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createServer } from 'node:http'
import Storage, { type StorageBackend } from '@antarestra/storage'
import files from '@antarestra/plugin-workspace-file'
import type { Json, JsonObject, RequestSnapshot, RunContext } from '@antarestra/ai'
import * as OneBot from '../../plugins/adapters/im-onebot/src/index.js'
import { cleanup, setup } from './im-features-fixture.js'

afterEach(cleanup)
const poll = (read: () => unknown) => expect.poll(read, { timeout: 5000, interval: 20 })
const toolIds = ['onebot_get_forward_msg', 'onebot_set_msg_emoji_like', 'im_recall_message']
type Call = { name: string; arguments: JsonObject }
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
)
async function installStorage(ctx: Awaited<ReturnType<typeof setup>>['ctx']) {
  const blobs = new Map<string, Uint8Array>()
  const backend: StorageBackend = {
    async begin(upload) {
      return upload
    },
    async plan(upload) {
      return {
        driver: 'memory',
        headers: {},
        parts: [{ number: 1, url: upload.stagingKey, offset: 0, size: upload.size }],
      }
    },
    async write(upload, data, signal) {
      signal.throwIfAborted()
      blobs.set(upload.stagingKey, data)
      return []
    },
    async complete(upload) {
      blobs.set(upload.key, blobs.get(upload.stagingKey)!)
    },
    async discard(upload) {
      blobs.delete(upload.stagingKey)
    },
    async remove(key) {
      blobs.delete(key)
    },
    async read(key) {
      return blobs.get(key)!
    },
    async exists(key) {
      return blobs.has(key)
    },
    async download(key) {
      return `https://example.invalid/${key}`
    },
  }
  await ctx.plugin(Storage)
  ctx.storage.register(ctx, 'test', backend)
  await ctx.plugin(files, { backendId: 'test', defaultQuota: 1024 ** 2 })
  return blobs
}
async function createApp(
  calls: (Call | ((request: RequestSnapshot) => Call))[],
  withFiles = false,
) {
  const requests: RequestSnapshot[] = []
  const steps = new Map<string, number>()
  const app = await setup({
    ai: true,
    toolIds: withFiles ? [...toolIds, 'workspace_file_read'] : toolIds,
    modelInput: ['text', 'image'],
    driver: {
      id: 'driver',
      async generate(request, _connection, context) {
        requests.push(request)
        const step = steps.get(context.runId) ?? 0
        steps.set(context.runId, step + 1)
        const next = calls[step]
        const call = typeof next === 'function' ? next(request) : next
        return {
          content: call
            ? [{ type: 'tool-call', id: `call-${step}`, ...call }]
            : [{ type: 'text', text: '完成' }],
        }
      },
    },
  })
  const blobs = withFiles ? await installStorage(app.ctx) : undefined
  const registered = vi.spyOn(app.ctx.ai, 'registerTool')
  async function connect(connectionId: string, selfId: string) {
    const fiber = await app.ctx.plugin(OneBot, {
      id: connectionId,
      selfId,
      token: 'test-secret',
      rpcTimeoutMs: 1000,
    })
    await app.ctx.im.setPolicy(connectionId, app.defaultPolicy)
    const socket = new WebSocket(
      `ws://127.0.0.1:${app.ctx.server.address!.port}/im/onebot/${connectionId}`,
      {
        headers: {
          Authorization: 'Bearer test-secret',
          'X-Self-ID': selfId,
          'X-Client-Role': 'Universal',
        },
      },
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const actions: { action: string; params: JsonObject }[] = []
    let messageGroup = '40894918'
    let messageSender = selfId
    let messageType = 'group'
    let stalled: string | undefined
    let failure: string | undefined
    let forward: Json = {
      messages: [
        {
          sender: { user_id: 42, nickname: '转发者' },
          time: 1720000000,
          content: [{ type: 'text', data: { text: '转发内部内容' } }],
        },
      ],
    }
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        action: string
        params: JsonObject
        echo: string
      }
      actions.push(request)
      if (request.action === stalled) return
      const data =
        request.action === 'get_group_member_info'
          ? { user_id: request.params.user_id, role: 'member' }
          : request.action === 'get_msg'
            ? {
                message_id: Number(request.params.message_id),
                message_type: messageType,
                group_id: messageGroup,
                sender: { user_id: messageSender },
                message: [{ type: 'forward', data: { id: 'resource-1' } }],
              }
            : request.action === 'get_forward_msg'
              ? forward
              : request.action === 'get_image'
                ? { base64: png.toString('base64') }
                : request.action === 'send_group_msg' || request.action === 'send_private_msg'
                  ? { message_id: 100 }
                  : { result: true }
      socket.send(
        JSON.stringify({
          echo: request.echo,
          status: request.action === failure ? 'failed' : 'ok',
          retcode: request.action === failure ? 1200 : 0,
          data,
        }),
      )
    })
    const receive = (messageId = 1, privateChat = false) =>
      socket.send(
        JSON.stringify({
          post_type: 'message',
          self_id: selfId,
          message_type: privateChat ? 'private' : 'group',
          group_id: '40894918',
          message_id: messageId,
          user_id: '79338528',
          sender: { nickname: '测试用户' },
          message: [
            { type: 'text', data: { text: '/ai 请处理' } },
            { type: 'forward', data: { id: 'resource-1' } },
          ],
        }),
      )
    return {
      fiber,
      socket,
      actions,
      receive,
      setForward: (value: Json) => {
        forward = value
      },
      setGroup: (group: string) => {
        messageGroup = group
      },
      fail: (action: string) => {
        failure = action
      },
      setSender: (value: string) => {
        messageSender = value
      },
      setType: (value: string) => {
        messageType = value
      },
      stall: (value: string) => {
        stalled = value
      },
    }
  }
  return { ...app, blobs, requests, registered, connectOneBot: connect }
}

it('转发数组、CQ 和嵌套图片先入库去重，模型随后通过文件工具读取真实图片', async () => {
  const downloads: string[] = []
  const server = createServer((request, response) => {
    downloads.push(request.url!)
    response.setHeader('content-type', 'application/octet-stream')
    response.end(png)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const url = `http://127.0.0.1:${address.port}/download?appid=1407&fileid=example&rkey=example`
    let resourceId = ''
    const app = await createApp(
      [
        { name: toolIds[0]!, arguments: { message_id: '1' } },
        (request) => {
          const result = request.messages
            .flatMap((message) => message.content)
            .find((block) => block.type === 'tool-result' && block.id === 'call-0')
          resourceId = JSON.stringify(result).match(/"resourceId":"([^"]+)"/)?.[1] ?? ''
          expect(resourceId).not.toBe('')
          return { name: 'workspace_file_read', arguments: { resourceId } }
        },
      ],
      true,
    )
    const first = await app.connectOneBot('onebot-a', '05')
    const second = await app.connectOneBot('onebot-b', '06')
    first.setForward({
      messages: [
        {
          sender: { user_id: 42, nickname: '转发者' },
          time: 1720000000,
          raw_message: `前文[CQ:image,file=example.jpg,url=${url.replaceAll('&', '&amp;')}]后文`,
          message: [
            { type: 'text', data: { text: '原始文字' } },
            { type: 'image', data: { file: 'example.jpg', url } },
            {
              type: 'node',
              data: {
                user_id: 43,
                content: [
                  { type: 'image', data: { file: 'platform-only.png' } },
                  { type: 'text', data: { text: '嵌套文字' } },
                ],
              },
            },
          ],
          content: '[CQ:image,file=platform-only.png]',
        },
      ],
    })
    first.receive()
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    expect(downloads).toEqual(['/download?appid=1407&fileid=example&rkey=example'])
    expect(first.actions.filter((entry) => entry.action === 'get_image')).toEqual([
      expect.objectContaining({ params: { file: 'platform-only.png' } }),
    ])
    expect(second.actions).toEqual([])
    expect(app.blobs?.size).toBe(2)
    const result = JSON.stringify(app.requests[1])
    expect(result).toContain(`[图片,${resourceId}]`)
    expect(result).not.toContain('[CQ:image')
    expect(result).not.toContain('rkey=')
    expect(result).toContain('转发者')
    expect(result).toContain('1720000000')
    expect(result).toContain('原始文字')
    expect(result).toContain('嵌套文字')
    expect(app.requests.at(-1)?.messages.flatMap((message) => message.content)).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        id: 'call-1',
        isError: false,
        images: [
          expect.objectContaining({ resourceId, mimeType: 'image/png', width: 1, height: 1 }),
        ],
      }),
    )
    const access = await app.ctx.workspaceFile.authorize('im', app.messages[0]!.request)
    expect((await app.ctx.workspaceFile.readResource(access, resourceId)).bytes).toEqual(png)
    await app.connection.receive('其他空间')
    const other = await app.ctx.workspaceFile.authorize('im', app.messages.at(-1)!.request)
    await expect(app.ctx.workspaceFile.resource(other, resourceId)).rejects.toThrow('文件已过期')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('损坏、超限和下载失败图片不伪造资源 ID，也不阻断其他图片与文字', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/denied') response.writeHead(403)
    else if (request.url === '/large') response.setHeader('content-length', 8 * 1024 ** 2 + 1)
    response.end('not-an-image')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const base = `http://127.0.0.1:${address.port}`
    const app = await createApp([{ name: toolIds[0]!, arguments: { message_id: '1' } }], true)
    const bot = await app.connectOneBot('onebot-a', '05')
    bot.setForward({
      messages: [
        {
          content: [
            ...['denied', 'large', 'broken'].map((path) => ({
              type: 'image',
              data: { url: `${base}/${path}` },
            })),
            { type: 'image', data: {} },
            { type: 'text', data: { text: '保留文字' } },
            { type: 'image', data: { file: 'good.png' } },
          ],
        },
      ],
    })
    bot.receive()
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    const result = app.requests
      .at(-1)!
      .messages.flatMap((message) => message.content)
      .find((block) => block.type === 'tool-result')!
    const json = JSON.stringify(result)
    expect(json.match(/"status":"failed"/g)).toHaveLength(4)
    expect(json.match(/"resourceId":/g)).toHaveLength(1)
    expect(json).toContain('保留文字')
    expect(json).toContain('无法识别图片')
    expect(json).not.toContain(base)
    expect(app.blobs?.size).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('未加载图片存储时明确标记失败，取消的媒体下载停止且拒绝跨空间目标', async () => {
  const app = await createApp([{ name: toolIds[0]!, arguments: { message_id: '1' } }])
  const bot = await app.connectOneBot('onebot-a', '05')
  bot.setForward({ messages: [{ content: '文字[CQ:image,file=only.png]' }] })
  bot.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(JSON.stringify(app.requests.at(-1))).toContain('图片附件存储不可用')
  expect(JSON.stringify(app.requests.at(-1))).not.toContain('[CQ:image')
  const message = app.messages[0]!
  const target = await app.ctx.im.resolveTarget(message.workspaceId)
  const segment = { type: 'image' as const, url: 'onebot://file/only.png' }
  await expect(
    app.ctx.im.downloadMedia(
      { ...target, chat: { ...target.chat, id: 'foreign' } },
      message.message,
      segment,
      message.signal,
      1000,
    ),
  ).rejects.toThrow('媒体下载目标不属于当前空间')
  const prior = bot.actions.length
  await expect(
    app.ctx.im.downloadMedia(target, message.message, segment, AbortSignal.abort(), 1000),
  ).rejects.toThrow()
  expect(bot.actions).toHaveLength(prior)
})

it.each(['取消', '卸载'] as const)('%s 接入媒体下载时关闭请求并等待清理', async (operation) => {
  let requested = false
  let closed = false
  const server = createServer((request) => {
    requested = true
    request.on('close', () => {
      closed = true
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const app = await createApp([])
    const bot = await app.connectOneBot('onebot-a', '05')
    bot.receive()
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    const message = app.messages[0]!
    const target = await app.ctx.im.resolveTarget(message.workspaceId)
    const controller = new AbortController()
    const pending = app.ctx.im.downloadMedia(
      target,
      message.message,
      { type: 'image', url: `http://127.0.0.1:${address.port}/pending` },
      controller.signal,
      1000,
    )
    const rejected = expect(pending).rejects.toThrow()
    await poll(() => requested).toBe(true)
    if (operation === '取消') controller.abort()
    else await bot.fiber.dispose()
    await rejected
    await poll(() => closed).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('模型实际调用两个工具，保留转发内容并发送指定表情，描述包含全部指定表情', async () => {
  const app = await createApp([
    { name: toolIds[0]!, arguments: { message_id: '1', id: 'resource-1' } },
    { name: toolIds[1]!, arguments: { message_id: '1', emoji_id: '424' } },
  ])
  const bot = await app.connectOneBot('onebot-a', '05')
  bot.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(
    bot.actions.filter((entry) => toolIds.some((id) => id === `onebot_${entry.action}`)),
  ).toEqual([
    expect.objectContaining({ action: 'get_forward_msg', params: { id: 'resource-1' } }),
    expect.objectContaining({
      action: 'set_msg_emoji_like',
      params: { message_id: '1', emoji_id: '424', set: true },
    }),
  ])
  expect(JSON.stringify(app.requests.at(-1))).toContain('转发内部内容')
  expect(JSON.stringify(app.requests[0])).toContain('[合并转发,resource-1]')
  const tool = app.registered.mock.calls.find(([, tool]) => tool.id === toolIds[1])![1]
  for (const value of [
    '424',
    '10068',
    '264',
    '128560',
    '265',
    '76',
    '123',
    '128557',
    '49',
    '66',
    '不知道回复什么',
    '地铁老人手机.jpg',
  ])
    expect(tool.description).toContain(value)
  await expect(
    tool.execute({ message_id: '1', emoji_id: '66' }, { runId: 'fake' } as RunContext),
  ).resolves.toMatchObject({ isError: true, content: { error: 'OneBot 工具需要有效工具上下文' } })
})

it.each([
  { name: toolIds[1]!, arguments: { message_id: '999', emoji_id: '66' } },
  { name: toolIds[0]!, arguments: { message_id: '1', id: 'foreign-resource' } },
  { name: toolIds[1]!, arguments: { message_id: '1', emoji_id: '999' } },
  { name: toolIds[0]!, arguments: { message_id: '1', workspaceId: 'foreign' } },
])('拒绝越界参数 %j，不执行目标 RPC', async (call) => {
  const app = await createApp([call])
  const bot = await app.connectOneBot('onebot-a', '05')
  bot.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(
    bot.actions.filter((entry) => ['set_msg_emoji_like', 'get_forward_msg'].includes(entry.action)),
  ).toEqual([])
  expect(bot.actions.filter((entry) => entry.action === 'get_msg')).toHaveLength(
    call.arguments.id ? 1 : 0,
  )
  if (call.arguments.emoji_id === '999' || call.arguments.workspaceId) {
    expect((await app.jobs())[0]?.status).toBe('failed')
    expect(app.requests).toHaveLength(1)
  } else {
    expect(app.requests.at(-1)?.messages.flatMap((message) => message.content)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-result', isError: true })]),
    )
  }
})

it('同号消息按空间选择实际账号，多实例覆盖后卸载恢复可用实现', async () => {
  const app = await createApp([
    { name: toolIds[1]!, arguments: { message_id: '1', emoji_id: '76' } },
  ])
  const first = await app.connectOneBot('onebot-a', '05')
  const second = await app.connectOneBot('onebot-b', '06')
  first.receive()
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(1)
  second.receive()
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(2)
  expect(first.actions.filter((entry) => entry.action === 'set_msg_emoji_like')).toHaveLength(1)
  expect(second.actions.filter((entry) => entry.action === 'set_msg_emoji_like')).toHaveLength(1)
  await second.fiber.dispose()
  first.receive(2)
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(3)
  expect(first.actions.filter((entry) => entry.action === 'set_msg_emoji_like')).toHaveLength(2)
  await first.fiber.dispose()
  expect(JSON.stringify(app.ctx.ai.capabilities())).not.toContain('onebot_get_forward_msg')
  expect(JSON.stringify(app.ctx.ai.capabilities())).not.toContain('onebot_set_msg_emoji_like')
})

it('平台返回消息归属不符时禁止表态，平台失败反馈到模型', async () => {
  const app = await createApp([
    { name: toolIds[1]!, arguments: { message_id: '1', emoji_id: '66' } },
  ])
  const bot = await app.connectOneBot('onebot-a', '05')
  bot.setGroup('other-group')
  bot.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(bot.actions.some((entry) => entry.action === 'set_msg_emoji_like')).toBe(false)
  expect(JSON.stringify(app.requests.at(-1))).toContain('消息不属于当前聊天')
  bot.setGroup('40894918')
  bot.fail('set_msg_emoji_like')
  bot.receive(2)
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(2)
  expect(JSON.stringify(app.requests.at(-1))).toContain('OneBot 操作失败（1200）')
})

it('非 OneBot 空间不可借用已注册的 OneBot 工具', async () => {
  const app = await createApp([{ name: toolIds[0]!, arguments: { message_id: '1' } }])
  const bot = await app.connectOneBot('onebot-a', '05')
  await app.connection.receive('/ai 读取转发', { id: '1' })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(bot.actions).toEqual([])
  expect(JSON.stringify(app.requests.at(-1))).toContain('当前空间不是 OneBot 聊天')
})

it('未声明撤回能力的接入返回结构化错误，不借用其他平台连接', async () => {
  const app = await createApp([{ name: 'im_recall_message', arguments: { message_id: '1' } }])
  const bot = await app.connectOneBot('onebot-a', '05')
  await app.connection.receive('/ai 撤回', { id: '1' })
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  expect(bot.actions).toEqual([])
  expect(JSON.stringify(app.requests.at(-1))).toContain('unsupported')
})

it('AI 撤回上一轮已发送消息，保留本地归档；不同账号只操作各自聊天', async () => {
  const calls: Call[] = []
  const app = await createApp(calls)
  const first = await app.connectOneBot('onebot-a', '05')
  const second = await app.connectOneBot('onebot-b', '06')
  first.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  calls.push({ name: 'im_recall_message', arguments: { message_id: '100' } })
  first.receive(2)
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(2)
  expect(first.actions.filter((entry) => entry.action === 'delete_msg')).toEqual([
    expect.objectContaining({ params: { message_id: '100' } }),
  ])
  expect(second.actions).toEqual([])
  expect(JSON.stringify(app.requests.at(-1))).toContain('"recalled":true')
  expect(
    (await app.ctx.im.history(app.messages[0]!.workspaceId)).some(
      (entry) => entry.message.id === '100',
    ),
  ).toBe(true)
  second.receive()
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(3)
  expect(second.actions.some((entry) => entry.action === 'delete_msg')).toBe(false)
  expect(JSON.stringify(app.requests.at(-1))).toContain('撤回消息不属于当前空间')
})

it.each(['他人消息', '其他群', '平台失败', '未记录消息'] as const)(
  '撤回拒绝或反馈：%s',
  async (mode) => {
    const app = await createApp([
      { name: 'im_recall_message', arguments: { message_id: mode === '未记录消息' ? '999' : '1' } },
    ])
    const bot = await app.connectOneBot('onebot-a', '05')
    if (mode === '他人消息') bot.setSender('someone-else')
    if (mode === '其他群') bot.setGroup('other-group')
    if (mode === '平台失败') bot.fail('delete_msg')
    bot.receive()
    await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
    expect(bot.actions.filter((entry) => entry.action === 'delete_msg')).toHaveLength(
      mode === '平台失败' ? 1 : 0,
    )
    expect(app.requests.at(-1)?.messages.flatMap((message) => message.content)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-result', isError: true })]),
    )
  },
)

it.each(['取消', '卸载'] as const)('撤回等待期间%s不会执行 delete_msg', async (operation) => {
  const app = await createApp([])
  const bot = await app.connectOneBot('onebot-a', '05')
  bot.receive()
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  const target = await app.ctx.im.resolveTarget(app.messages[0]!.workspaceId)
  bot.stall('get_msg')
  const controller = new AbortController()
  const work = app.ctx.im.invoke(target, 'message.recall', { message_id: '100' }, controller.signal)
  const rejected = expect(work).rejects.toThrow()
  await poll(() => bot.actions.some((entry) => entry.action === 'get_msg')).toBe(true)
  if (operation === '取消') controller.abort()
  else await bot.fiber.dispose()
  await rejected
  expect(bot.actions.some((entry) => entry.action === 'delete_msg')).toBe(false)
})

it('私聊撤回使用持久化空间归属，禁用聊天后拒绝操作', async () => {
  const calls: Call[] = []
  const app = await createApp(calls)
  const bot = await app.connectOneBot('onebot-a', '05')
  await app.ctx.im.setPolicy('onebot-a', {
    private: { mode: 'whitelist', ids: ['79338528'], defaults: { ai: true, agentId: 'assistant' } },
  })
  bot.setType('private')
  bot.receive(1, true)
  await poll(async () => (await app.jobs())[0]?.delivery).toBe('sent')
  calls.push({ name: 'im_recall_message', arguments: { message_id: '100' } })
  bot.receive(2, true)
  await poll(async () => (await app.jobs()).filter((job) => job.delivery === 'sent').length).toBe(2)
  expect(bot.actions.filter((entry) => entry.action === 'delete_msg')).toHaveLength(1)
  const target = await app.ctx.im.resolveTarget(app.messages[0]!.workspaceId)
  await app.ctx.im.setPolicy('onebot-a', { enabled: false })
  await expect(app.ctx.im.invoke(target, 'message.recall', { message_id: '100' })).rejects.toThrow(
    '禁用',
  )
  expect(bot.actions.filter((entry) => entry.action === 'delete_msg')).toHaveLength(1)
})
