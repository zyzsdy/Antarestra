import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto'
import { AuthError } from '@antarestra/rbac'

const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, options, (error, result) =>
      error ? reject(error) : resolve(result),
    )
  })

export function loginName(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError(400, '登录名格式无效')
  const normalized = value.trim().normalize('NFKC').toLowerCase()
  if (!normalized || normalized.length > 254 || /[\s\x00-\x1f\x7f]/.test(normalized))
    throw new AuthError(400, '登录名必须为 1–254 个不含空白的字符')
  return normalized
}

export function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new AuthError(400, '密码长度必须为 8 到 128 个字符')
  return value
}

export const emailKey = (value: string): string => createHash('sha256').update(value).digest('hex')

const lower = 'abcdefghjklmnpqrstuvwxyz'
const digits = '23456789'
const symbols = '~@#$%^&*:+-=<>?/\\'
const pick = (characters: string): string => characters[randomInt(characters.length)]!

export function generateInitialPassword(): string {
  const characters = [pick(lower), pick(digits), pick(symbols)]
  const all = lower + digits + symbols
  while (characters.length < 16) characters.push(pick(all))
  for (let index = characters.length - 1; index > 0; index--) {
    const target = randomInt(index + 1)
    ;[characters[index], characters[target]] = [characters[target]!, characters[index]!]
  }
  return characters.join('')
}
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
