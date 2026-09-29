import { afterEach, expect, it, vi } from 'vitest'
import { upload } from '../../plugins/implementations/storage-s3/client/upload.js'
import type { UploadPlan } from '@antarestra/storage'
afterEach(() => vi.unstubAllGlobals())
const plan: UploadPlan = {
  driver: 's3',
  headers: { 'If-None-Match': '*' },
  parts: [
    { number: 1, url: 'https://storage.example.com/one', offset: 0, size: 3 },
    { number: 2, url: 'https://storage.example.com/two', offset: 3, size: 2 },
  ],
}
it('浏览器上传执行器按偏移发送分片、不携带账号 Cookie，并回传真实 ETag 和进度', async () => {
  const bodies: string[] = []
  const request = vi.fn(async (_url: string, input: RequestInit) => {
    expect(input.credentials).toBe('omit')
    bodies.push(await (input.body as Blob).text())
    return new Response('', { status: 200, headers: { ETag: `part-${bodies.length}` } })
  })
  vi.stubGlobal('fetch', request)
  const progress = vi.fn()
  expect(await upload(new Blob(['abcde']), plan, new AbortController().signal, progress)).toEqual([
    { number: 1, etag: 'part-1' },
    { number: 2, etag: 'part-2' },
  ])
  expect(bodies).toEqual(['abc', 'de'])
  expect(progress.mock.calls).toEqual([
    [3, 5],
    [5, 5],
  ])
})
it('CORS 缺少 ETag、请求失败和用户取消均停止后续分片', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 200 })),
  )
  await expect(upload(new Blob(['abcde']), plan, new AbortController().signal)).rejects.toThrow(
    'ETag',
  )
  const controller = new AbortController()
  controller.abort()
  const request = vi.fn(async () => {
    throw new TypeError('Failed to fetch')
  })
  vi.stubGlobal('fetch', request)
  await expect(upload(new Blob(['abcde']), plan, controller.signal)).rejects.toThrow('取消')
  expect(request).toHaveBeenCalledTimes(1)
  await expect(upload(new Blob(['abcde']), plan, new AbortController().signal)).rejects.toThrow(
    'CORS',
  )
})
