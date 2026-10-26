import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { downloadHttpMedia } from '@antarestra/im'
import { normalizeMessage as onebot } from '../../plugins/adapters/im-onebot/src/message.js'
import { normalizeMessage as feishu } from '../../plugins/adapters/im-feishu/src/message.js'
import { downloadMedia as onebotMedia } from '../../plugins/adapters/im-onebot/src/media.js'

it('OneBot 图片优先下载直链，兼容旧归档，失败、超限和取消不会重复调用平台', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const requests: string[] = []
  const controller = new AbortController()
  const server = createServer((request, response) => {
    requests.push(request.url!)
    if (request.url === '/cancel') {
      controller.abort()
      response.end()
      return
    }
    if (request.url === '/expired') {
      response.writeHead(403)
      response.end()
      return
    }
    response.setHeader('content-type', 'application/octet-stream')
    response.end(png)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const url = `http://127.0.0.1:${address.port}/image`
    const message = onebot(
      {
        self_id: '1',
        user_id: '2',
        group_id: '3',
        post_type: 'message',
        message_type: 'group',
        message_id: '4',
        message: [{ type: 'image', data: { file: 'missing-file', url, name: '图片.png' } }],
      },
      '1',
    )!
    const segment = message.segments[0]!
    if (!('url' in segment)) throw new Error('媒体段缺失')
    const rpc = vi.fn(async () => {
      throw new Error('file not found')
    })
    const signal = new AbortController().signal
    const { reference, ...legacy } = segment
    expect(reference).toBeDefined()
    for (const input of [segment, legacy]) {
      expect(await onebotMedia(message, input, signal, 8, rpc)).toEqual({
        data: png,
        mimeType: 'image/png',
        filename: '图片.png',
      })
    }
    // HTTP 正文超限与元数据超限均不可绕过限制改走 RPC。
    await expect(onebotMedia(message, segment, signal, 7, rpc)).rejects.toThrow('上限')
    await expect(onebotMedia(message, { ...segment, size: 9 }, signal, 8, rpc)).rejects.toThrow(
      '上限',
    )
    await expect(onebotMedia(message, segment, AbortSignal.abort(), 8, rpc)).rejects.toThrow()
    await expect(
      onebotMedia(
        message,
        {
          ...segment,
          url: url.replace('/image', '/cancel'),
        },
        controller.signal,
        8,
        rpc,
      ),
    ).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
    expect(requests).toEqual(['/image', '/image', '/image', '/cancel'])

    // 有引用时直链失效只刷新一次；平台仍找不到文件就保留失败。
    const expired = { ...segment, url: url.replace('/image', '/expired') }
    await expect(onebotMedia(message, expired, signal, 8, rpc)).rejects.toThrow('file not found')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_image', { file: 'missing-file' }, signal)
    // 没有平台引用时保留 HTTP 错误，不重复下载，也不调用平台。
    await expect(
      onebotMedia(
        { ...message, raw: {} },
        {
          ...legacy,
          url: expired.url,
        },
        signal,
        8,
        rpc,
      ),
    ).rejects.toThrow('HTTP 403')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(requests.slice(-2)).toEqual(['/expired', '/expired'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('HTTP 媒体下载保留二进制和类型，限制流大小、拒绝本地协议并报告失败状态码', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/forbidden')) {
      response.writeHead(403)
      response.end('private-response')
      return
    }
    response.setHeader('content-type', 'image/png')
    response.write(Buffer.from([1, 2]))
    response.end(Buffer.from([3, 4]))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const segment = { type: 'image' as const, url: `http://127.0.0.1:${address.port}/image` }
    const signal = new AbortController().signal
    expect(await downloadHttpMedia(segment, signal, 4)).toMatchObject({
      data: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/png',
    })
    await expect(downloadHttpMedia(segment, signal, 3)).rejects.toThrow('上限')
    await expect(
      downloadHttpMedia({ ...segment, url: 'file:///secret' }, signal, 4),
    ).rejects.toThrow('地址无效')
    await expect(
      downloadHttpMedia(
        { ...segment, url: `http://127.0.0.1:${address.port}/forbidden?token=secret` },
        signal,
        4,
      ),
    ).rejects.toThrow(/^媒体下载失败：HTTP 403 Forbidden$/)
    await expect(downloadHttpMedia(segment, AbortSignal.abort(), 4)).rejects.toThrow()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('OneBot 保留视频音频、CQ 文本结构和群文件通知，未知内容仍留下原始信息', () => {
  const base = {
    self_id: '1',
    user_id: '2',
    group_id: '3',
    post_type: 'message',
    message_type: 'group',
    message_id: '4',
  }
  expect(
    onebot(
      {
        ...base,
        message:
          '你好[CQ:at,qq=1][CQ:video,file=https://example.invalid/a][CQ:record,file=https://example.invalid/b]',
      },
      '1',
    )?.segments.map((segment) => segment.type),
  ).toEqual(['text', 'mention', 'video', 'audio'])
  const upload = onebot(
    {
      ...base,
      post_type: 'notice',
      notice_type: 'group_upload',
      file: { id: 'file-id', busid: 102, name: '原始文件.txt' },
    },
    '1',
  )
  expect(upload?.segments).toEqual([
    {
      type: 'file',
      url: 'onebot://group-file/file-id/102',
      reference: 'onebot://group-file/file-id/102',
      name: '原始文件.txt',
    },
  ])
  expect(
    onebot({ ...base, message: [{ type: 'forward', data: { id: 'ref' } }] }, '1'),
  ).toMatchObject({
    segments: [{ type: 'forward', id: 'ref' }],
    raw: { message: [{ type: 'forward' }] },
  })
  expect(onebot({ ...base, message: [{ type: 'json', data: { data: '{}' } }] }, '1')).toMatchObject(
    {
      segments: [{ type: 'unsupported', name: 'json' }],
      raw: { message: [{ type: 'json' }] },
    },
  )
})

it('飞书富文本中的文字、图片、视频和提及按原始顺序保留', () => {
  const account = { appId: 'app', tenantId: 'tenant', botOpenId: 'bot' }
  const result = feishu(
    {
      app_id: 'app',
      tenant_key: 'tenant',
      sender: { sender_type: 'user', sender_id: { open_id: 'user' } },
      message: {
        message_id: 'm',
        chat_id: 'g',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            title: '标题',
            content: [
              [
                { tag: 'text', text: '正文' },
                { tag: 'img', image_key: 'img' },
                { tag: 'media', file_key: 'video' },
                { tag: 'at', user_id: 'bot' },
              ],
            ],
          },
        }),
      },
    },
    account,
  )
  expect(result?.segments.map((segment) => segment.type)).toEqual([
    'text',
    'text',
    'image',
    'video',
    'mention',
    'text',
  ])
})

it('OneBot 无直链的文件保留资源 ID，语音通过平台 RPC 获取二进制且不读取平台本地路径', async () => {
  const message = onebot(
    {
      self_id: '1',
      user_id: '2',
      group_id: '3',
      post_type: 'message',
      message_type: 'group',
      message_id: '4',
      message: [{ type: 'record', data: { file_id: 'opaque/id' } }],
    },
    '1',
  )!
  const segment = message.segments[0]!
  expect(segment).toEqual({
    type: 'audio',
    url: 'onebot://file/opaque%2Fid',
    reference: 'onebot://file/opaque%2Fid',
  })
  if (!('url' in segment)) throw new Error('媒体段缺失')
  const signal = new AbortController().signal
  const rpc = async (action: string, params: Record<string, unknown>) => {
    expect(action).toBe('get_record')
    expect(params).toEqual({ file: 'opaque/id', out_format: 'mp3' })
    return { base64: 'AQID', file: '/bot/voice.mp3' }
  }
  expect(await onebotMedia(message, segment, signal, 3, rpc)).toMatchObject({
    data: Buffer.from([1, 2, 3]),
    mimeType: 'audio/mpeg',
    filename: '语音.mp3',
  })
  await expect(onebotMedia(message, segment, signal, 2, rpc)).rejects.toThrow('上限')
  await expect(
    onebotMedia(message, segment, signal, 3, async () => ({ url: '/bot/voice.mp3' })),
  ).rejects.toThrow('URL')
})

it.each([
  ['group', 'file', 'get_group_file_url'],
  ['private', 'file', 'get_private_file_url'],
  ['group', 'video', 'get_file'],
  ['group', 'image', 'get_image'],
] as const)('%s 的 %s 使用稳定标识重新获取直链', async (chat, type, action) => {
  const server = createServer((request, response) => {
    if (request.url === '/old') {
      response.writeHead(403)
      response.end()
      return
    }
    response.setHeader('content-type', 'application/octet-stream')
    response.end(Buffer.from('89504e470d0a1a0a', 'hex'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('监听失败')
    const message = onebot(
      {
        self_id: '1',
        user_id: '2',
        group_id: '3',
        post_type: 'message',
        message_type: chat,
        message_id: '4',
        message: [
          {
            type,
            data: {
              file_id: 'stable/id',
              url: `http://127.0.0.1:${address.port}/old`,
              name: '图片.png',
              file_size: '8',
              busid: 102,
            },
          },
        ],
      },
      '1',
    )!
    const segment = message.segments[0]!
    if (!('url' in segment)) throw new Error('媒体段缺失')
    let calls = 0
    const rpc = async (name: string, params: Record<string, unknown>) => {
      calls++
      expect(name).toBe(action)
      expect(params).toEqual(
        type === 'file'
          ? chat === 'group'
            ? { group_id: '3', file_id: 'stable/id', busid: 102 }
            : { file_id: 'stable/id' }
          : { file: 'stable/id' },
      )
      return { url: `http://127.0.0.1:${address.port}/new` }
    }
    // 同时验证新消息以及没有 reference 的旧归档，从 raw 恢复标识。
    for (const input of [segment, { ...segment, reference: undefined }]) {
      const { reference, ...legacy } = input
      const result = await onebotMedia(
        message,
        reference ? segment : legacy,
        new AbortController().signal,
        8,
        rpc,
        'napcat',
      )
      expect(result).toMatchObject({
        filename: '图片.png',
        mimeType: 'image/png',
        data: Buffer.from('89504e470d0a1a0a', 'hex'),
      })
    }
    expect(calls).toBe(2)
    await expect(
      onebotMedia(message, segment, new AbortController().signal, 7, rpc),
    ).rejects.toThrow('上限')
    expect(calls).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
