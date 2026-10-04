import { AuthError } from '@antarestra/rbac'
import { imageSize } from 'image-size'

export function imageDimensions(bytes: Uint8Array, mimeType: string) {
  let dimensions: ReturnType<typeof imageSize>
  try {
    dimensions = imageSize(bytes)
  } catch {
    throw new AuthError(400, '无法识别图片格式或尺寸，文件可能已损坏')
  }
  if (
    `image/${dimensions.type === 'jpg' ? 'jpeg' : dimensions.type}` !== mimeType ||
    !Number.isSafeInteger(dimensions.width) ||
    dimensions.width <= 0 ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.height <= 0
  )
    throw new AuthError(400, '图片内容与声明格式不符或尺寸无效')
  return dimensions
}
export function filePath(value: unknown, root = false): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.length > 1024 ||
    /[\\\x00-\x1f\x7f]/.test(value)
  )
    throw new AuthError(400, '路径必须是以 / 开头的绝对路径')
  const parts = value.normalize('NFC').split('/').filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..' || p.length > 255))
    throw new AuthError(400, '路径包含无效目录')
  const path = '/' + parts.join('/')
  if (!root && path === '/') throw new AuthError(400, '不能修改根目录')
  return path
}
export function sizeValue(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new AuthError(400, '大小必须是有效的非负整数字节数')
  return value
}
