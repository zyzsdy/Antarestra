import { expect, it } from 'vitest'
import { filePayload } from '../../plugins/features/ai-provider/src/attachments.js'
import { nativeFiles } from '../../plugins/features/ai-provider/src/native-files.js'
import { createServer } from 'node:http'
const pdf = { filename: '说明.pdf', mimeType: 'application/pdf', data: 'aGVsbG8=' }
it('办公文档通过官方 SDK 上传，使用 file_id 并在完成或部分失败时删除远端副本', async () => {
  const requests: { method: string; url: string; body: string }[] = []
  let fail = false
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk.toString()
    requests.push({ method: request.method!, url: request.url!, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST' && fail && body.includes('second.docx')) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: { message: '不支持该文件' } }))
    } else
      response.end(
        JSON.stringify({ id: 'native-file', object: 'file', deleted: request.method === 'DELETE' }),
      )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const file = {
    filename: 'example.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: Buffer.from('PK-document').toString('base64'),
  }
  const connection = { baseUrl: `http://127.0.0.1:${address.port}`, credential: 'test-key' }
  try {
    const uploaded = await nativeFiles(
      'openai-responses',
      new Map([['workspace-id', file]]),
      connection,
      {},
      new AbortController().signal,
    )
    expect(requests[0]?.body).toContain('PK-document')
    expect(requests[0]?.body).toContain('user_data')
    expect(requests[0]?.body).toContain('3600')
    const payload = filePayload('openai-responses', uploaded.ids)
    expect(payload.transform([payload.placeholder(file, 'workspace-id')])).toEqual([
      { type: 'input_file', file_id: 'native-file' },
    ])
    await uploaded.dispose()
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/files/native-file' })
    fail = true
    await expect(
      nativeFiles(
        'openai-responses',
        new Map([
          ['first', file],
          ['second', { ...file, filename: 'second.docx' }],
        ]),
        connection,
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'attachment_upload_failed' })
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/files/native-file' })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
it('各接口通过 SDK payload 回调转换 PDF，不把 Base64 放进文本消息', () => {
  for (const [api, type] of [
    ['openai-responses', 'input_file'],
    ['openai-completions', 'file'],
    ['anthropic-messages', 'document'],
  ] as const) {
    const files = filePayload(api)
    const placeholder = files.placeholder(pdf)
    const transformed = files.transform({
      messages: [{ content: [placeholder, { type: 'text', text: '分析' }] }],
    }) as { messages: { content: { type: string }[] }[] }
    expect(transformed.messages[0]!.content[0]!.type).toBe(type)
    expect(transformed.messages[0]!.content[1]).toEqual({ type: 'text', text: '分析' })
    expect(JSON.stringify(transformed)).toContain(pdf.data)
    expect(JSON.stringify(transformed)).not.toContain('antarestra-attachment:')
  }
})
it('Google 使用 inlineData，其他接口发送 UTF-8 内容并拒绝不支持的二进制', () => {
  const files = filePayload('google-generative-ai')
  expect(files.transform({ contents: [{ parts: [files.placeholder(pdf)] }] })).toEqual({
    contents: [{ parts: [{ inlineData: { mimeType: pdf.mimeType, data: pdf.data } }] }],
  })
  const openai = filePayload('openai-responses')
  expect(
    openai.placeholder({
      filename: '说明.txt',
      mimeType: 'text/plain',
      data: Buffer.from('中文').toString('base64'),
    }),
  ).toEqual({ type: 'text', text: '附件：说明.txt\n中文' })
  expect(() =>
    openai.placeholder({ filename: 'archive.zip', mimeType: 'application/zip', data: 'AP8=' }),
  ).toThrow('二进制附件')
  expect(() => filePayload('mistral-conversations').placeholder(pdf)).toThrow('PDF')
})
