import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { normalizeMessage } from '../../plugins/adapters/im-onebot/src/message.js'
import { downloadMedia } from '../../plugins/adapters/im-onebot/src/media.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function mediaServer() {
  const data = Buffer.from('000000186674797069736f6d', 'hex')
  const server = createServer((request, response) => {
    if (request.url === '/expired') response.writeHead(403)
    response.end(data)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('监听失败')
  return { url: `http://127.0.0.1:${address.port}`, data }
}

function media(type: 'file' | 'video', data: Record<string, unknown>, chat = 'group') {
  const message = normalizeMessage(
    {
      self_id: 1,
      user_id: 2,
      group_id: 3,
      message_id: -4,
      post_type: 'message',
      message_type: chat,
      message: [{ type, data: { file_id: 'stable/id', ...data } }],
    },
    '1',
  )!
  const segment = message.segments[0]!
  if (segment.type !== type) throw new Error('媒体段缺失')
  return { message, segment }
}

it.each(['snowluma', 'napcat'] as const)(
  '%s 私聊文件使用各自的参数并兼容旧归档',
  async (provider) => {
    const { url, data } = await mediaServer()
    const { message, segment } = media('file', { file_hash: 'hash/+?=' }, 'private')
    expect(new URL(segment.reference!).searchParams.get('file_hash')).toBe('hash/+?=')
    const rpc = vi.fn(async (_action: string, _params: Record<string, unknown>) => ({
      url: `${url}/file`,
    }))
    // 包括只有旧 reference、以及 raw 已不含文件哈希但新引用仍保留它的情况。
    for (const [inputMessage, inputSegment] of [
      [message, segment],
      [message, { ...segment, reference: 'onebot://file/stable%2Fid/0' }],
      [{ ...message, raw: {} }, segment],
    ] as const) {
      expect(
        (
          await downloadMedia(
            inputMessage,
            inputSegment,
            new AbortController().signal,
            100,
            rpc,
            provider,
          )
        ).data,
      ).toEqual(data)
      expect(rpc.mock.calls.at(-1)?.[0]).toBe('get_private_file_url')
      expect(rpc.mock.calls.at(-1)?.[1]).toEqual(
        provider === 'snowluma'
          ? { file_id: 'stable/id', user_id: '2', file_hash: 'hash/+?=' }
          : { file_id: 'stable/id' },
      )
    }
  },
)

it.each(['snowluma', 'napcat'] as const)('%s 群文件区分缺省和显式 busid', async (provider) => {
  const { url } = await mediaServer()
  for (const busid of [undefined, 0, 102]) {
    const { message, segment } = media('file', busid === undefined ? {} : { busid })
    const rpc = vi.fn(async (_action: string, _params: Record<string, unknown>) => ({
      url: `${url}/file`,
    }))
    await downloadMedia(message, segment, new AbortController().signal, 100, rpc, provider)
    expect(rpc.mock.calls[0]).toEqual([
      'get_group_file_url',
      {
        group_id: '3',
        file_id: 'stable/id',
        ...(busid === undefined && provider === 'snowluma' ? {} : { busid: busid ?? 0 }),
      },
      expect.any(AbortSignal),
    ])
  }
})

it('SnowLuma 视频直链成功不调用 RPC；超限和取消不刷新', async () => {
  const { url, data } = await mediaServer()
  const { message, segment } = media('video', { url: `${url}/video` })
  const rpc = vi.fn(async () => {
    throw new Error('不应调用')
  })
  expect(
    await downloadMedia(message, segment, new AbortController().signal, 100, rpc),
  ).toMatchObject({
    data,
    mimeType: 'video/mp4',
  })
  await expect(
    downloadMedia(message, segment, new AbortController().signal, 1, rpc),
  ).rejects.toThrow('上限')
  await expect(downloadMedia(message, segment, AbortSignal.abort(), 100, rpc)).rejects.toThrow()
  expect(rpc).not.toHaveBeenCalled()
})

it.each(['group', 'private'])(
  'SnowLuma %s 视频用 get_msg 刷新，并核验消息归属和文件引用',
  async (chat) => {
    const { url, data } = await mediaServer()
    const { message, segment } = media('video', { url: `${url}/expired` }, chat)
    const response = {
      message_id: -4,
      message_type: chat,
      group_id: 3,
      user_id: 2,
      message: [{ type: 'video', data: { file_id: 'stable/id', url: `${url}/new` } }],
    }
    const rpc = vi.fn(async (_action: string, _params: Record<string, unknown>) => response)
    expect(
      (await downloadMedia(message, segment, new AbortController().signal, 100, rpc)).data,
    ).toEqual(data)
    expect(rpc.mock.calls[0]).toEqual(['get_msg', { message_id: '-4' }, expect.any(AbortSignal)])
    for (const changes of [
      { message_id: 5 },
      { message_type: 'other' },
      { group_id: 9, user_id: 9 },
    ]) {
      await expect(
        downloadMedia(message, segment, new AbortController().signal, 100, async () => ({
          ...response,
          ...changes,
        })),
      ).rejects.toThrow('不属于当前聊天')
    }
    for (const [file, mediaUrl] of [
      ['other/id', `${url}/new`],
      ['stable/id', '/bot/video.mp4'],
    ]) {
      await expect(
        downloadMedia(message, segment, new AbortController().signal, 100, async () => ({
          ...response,
          message: [{ type: 'video', data: { file_id: file, url: mediaUrl } }],
        })),
      ).rejects.toThrow('视频 URL')
    }
  },
)

it('NapCat 视频继续通过 get_file 获取内容', async () => {
  const { message, segment } = media('video', { url: 'https://example.invalid/video' })
  const rpc = vi.fn(async (_action: string, _params: Record<string, unknown>) => ({
    base64: 'AQID',
  }))
  expect(
    (await downloadMedia(message, segment, new AbortController().signal, 100, rpc, 'napcat')).data,
  ).toEqual(Buffer.from([1, 2, 3]))
  expect(rpc.mock.calls[0]).toEqual(['get_file', { file: 'stable/id' }, expect.any(AbortSignal)])
})
