import { expect, it } from 'vitest'
import { fileResponse } from '@antarestra/storage'
import { S3Backend } from '@antarestra/plugin-storage-s3'

it('仅允许明确的安全类型内联，拒绝主动内容和畸形类型', () => {
  for (const type of [
    'image/png',
    'image/jpeg',
    'image/webp',
    'audio/mpeg',
    'video/mp4',
    'text/plain',
  ])
    expect(fileResponse(type)).toEqual({ contentType: type, contentDisposition: 'inline' })
  for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'image/unknown'])
    expect(fileResponse(type)).toEqual({ contentType: type, contentDisposition: 'attachment' })
  expect(fileResponse('IMAGE/PNG')).toEqual({
    contentType: 'image/png',
    contentDisposition: 'inline',
  })
  for (const type of [undefined, '', 'image/png\r\nInjected: value'])
    expect(fileResponse(type)).toEqual({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
    })
})

it('S3 默认下载保留对象响应头，显式覆盖支持历史对象的图片展示', async () => {
  const backend = new S3Backend({
    endpoint: 'https://storage.example.com',
    bucket: 'test',
    accessKeyId: 'test',
    secretAccessKey: 'test',
  })
  try {
    const original = new URL(await backend.download('objects/test'))
    expect(original.searchParams.has('response-content-type')).toBe(false)
    expect(original.searchParams.has('response-content-disposition')).toBe(false)
    const image = new URL(
      await backend.download('objects/test', {
        contentType: 'image/png',
        contentDisposition: "inline; filename*=UTF-8''image.png",
      }),
    )
    expect(image.searchParams.get('response-content-type')).toBe('image/png')
    expect(image.searchParams.get('response-content-disposition')).toBe(
      "inline; filename*=UTF-8''image.png",
    )
  } finally {
    backend.close()
  }
})
