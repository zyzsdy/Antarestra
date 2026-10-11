import { expect, it, vi } from 'vitest'
import { ProviderImages } from '../../plugins/definitions/ai/src/provider-images.js'
import type { ContentBlock, GeneratedImage } from '@antarestra/ai'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ9kAAAAASUVORK5CYII='
const block: Extract<ContentBlock, { type: 'provider-tool' }> = {
  type: 'provider-tool',
  id: 'ig',
  name: 'draw',
  status: 'completed',
  result: { type: 'image_generation_call', output_format: 'png', result: png },
}
it.each([
  { result: '' },
  { result: 'not base64' },
  { result: 'aW1hZ2U=' },
  { result: png, output_format: 'jpeg' },
  { result: 'A'.repeat(Math.ceil((8 * 1024 ** 2) / 3) * 4 + 4) },
])('拒绝无效、伪装格式和超限图片，不调用存储', async (result) => {
  const store = vi.fn()
  const images = new ProviderImages(store)
  await expect(
    images.receive(
      { ...block, result: { ...block.result, ...result } },
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  expect(store).not.toHaveBeenCalled()
})
it('存储失败保留原始错误，重复事件不重复写入；未完成图片不存储', async () => {
  const error = new Error('空间配额不足')
  const store = vi.fn(async () => {
    throw error
  })
  const images = new ProviderImages(store)
  const signal = new AbortController().signal
  for (const status of ['in_progress', 'failed']) {
    const result = await images.receive({ ...block, status }, signal)
    expect(result.result).not.toHaveProperty('result')
  }
  expect(store).not.toHaveBeenCalled()
  await expect(images.receive(block, signal)).rejects.toBe(error)
  await expect(images.receive(block, signal)).rejects.toBe(error)
  expect(store).toHaveBeenCalledTimes(1)
})
it('多张图片分别保存，反馈只交付一次，取消后不再写入', async () => {
  const store = vi.fn(async (image: GeneratedImage) => ({
    type: 'image' as const,
    resourceId: image.filename,
    filename: image.filename,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    size: image.data.byteLength,
  }))
  const images = new ProviderImages(store)
  const controller = new AbortController()
  const first = await images.receive(block, controller.signal)
  const second = await images.receive({ ...block, id: 'ig2' }, controller.signal)
  expect(images.take([first, first, second])).toHaveLength(2)
  expect(images.take([first, second])).toEqual([])
  expect(store).toHaveBeenCalledTimes(2)
  controller.abort()
  await expect(images.receive({ ...block, id: 'ig3' }, controller.signal)).rejects.toThrow()
  expect(store).toHaveBeenCalledTimes(2)
})
