import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { downloadHttpMedia } from '@antarestra/im'
import { normalizeMessage as onebot } from '../../plugins/adapters/im-onebot/src/message.js'
import { normalizeMessage as feishu } from '../../plugins/adapters/im-feishu/src/message.js'
import { downloadMedia as onebotMedia } from '../../plugins/adapters/im-onebot/src/media.js'

it('HTTP 媒体下载保留二进制和类型，限制真实流大小并拒绝本地文件协议', async () => {
  const server = createServer((_request, response) => {
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
    { type: 'file', url: 'onebot://group-file/file-id/102', name: '原始文件.txt' },
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
  expect(segment).toEqual({ type: 'audio', url: 'onebot://file/opaque%2Fid' })
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
