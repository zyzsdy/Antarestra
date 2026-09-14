import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { AuthError } from '@antarestra/rbac'

const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, options, (error, result) =>
      error ? reject(error) : resolve(result),
    )
  })

export function email(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError(400, '邮箱格式无效')
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  if (
    normalized.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(normalized)
  )
    throw new AuthError(400, '邮箱格式无效')
  return normalized
}

export function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new AuthError(400, '密码长度必须为 8 到 128 个字符')
  return value
}

export const emailKey = (value: string): string => createHash('sha256').update(value).digest('hex')
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return `scrypt:32768:8:3:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt:32768:8:3:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(encoded)
  if (!match) return false
  return timingSafeEqual(
    await derive(password, Buffer.from(match[1]!, 'hex')),
    Buffer.from(match[2]!, 'hex'),
  )
}
