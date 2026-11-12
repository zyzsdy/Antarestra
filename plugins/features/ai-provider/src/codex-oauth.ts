import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import { AuthError } from '@antarestra/rbac'
import { check, object } from './validation.js'
import type { CodexTokens } from './codex-types.js'

export const codexIssuer = 'https://auth.openai.com'
export const codexResource = 'https://api.openai.com/v1'
export const codexScope =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const randomOAuthValue = () => randomBytes(32).toString('base64url')
export function authorizationUrl(input: {
  clientId?: string
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  verifier: string
}) {
  const url = new URL(codexIssuer + '/api/accounts/authorize')
  url.search = new URLSearchParams({
    client_id: input.clientId ?? 'dynamic_agent_client',
    ...(!input.clientId ? { agent_name_hint: 'Antarestra' } : {}),
    ext_agent_host_id: input.hostId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: codexScope,
    resource: codexResource,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(input.verifier).digest('base64url'),
  }).toString()
  return url.toString()
}

/** 不将上游响应正文、授权码或令牌拼接到错误中。 */
export async function oauthJson(url: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new AuthError(502, `OpenAI 请求失败（HTTP ${response.status}），请重试或重新授权`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new AuthError(502, 'OpenAI 返回了空响应')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 4_194_304) throw new AuthError(502, 'OpenAI 响应超过大小限制')
      chunks.push(chunk.value)
    }
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } finally {
    await reader.cancel()
  }
}
export function exchangeTokens(parameters: Record<string, string>, signal: AbortSignal) {
  return oauthJson(codexIssuer + '/api/accounts/oauth/token', signal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, resource: codexResource }),
  })
}
export function parseTokens(body: Record<string, unknown>, previous?: CodexTokens): CodexTokens {
  const accessToken = body.access_token
  const refreshToken = body.refresh_token
  const idToken = body.id_token ?? previous?.idToken
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/) : previous?.scopes
  check(typeof accessToken === 'string' && accessToken.length > 0, '授权缺少访问令牌')
  check(typeof refreshToken === 'string' && refreshToken.length > 0, '授权缺少刷新令牌')
  check(typeof idToken === 'string' && idToken.length > 0, '授权缺少身份令牌')
  check(body.token_type === 'Bearer' || body.token_type === 'bearer', '授权令牌类型无效')
  check(
    typeof body.expires_in === 'number' && body.expires_in > 0 && body.expires_in <= 86400,
    '授权有效期无效',
  )
  check(
    scopes && scopes.includes('chatgpt.tokens.use.direct') && scopes.includes('resource.invoke'),
    '未允许使用 ChatGPT 订阅，请重新授权并允许订阅访问',
  )
  return {
    accessToken,
    refreshToken,
    idToken,
    scopes,
    expiresAt: Date.now() + body.expires_in * 1000,
  }
}
export async function verifyIdentity(
  token: string,
  clientId: string,
  nonce: string | undefined,
  signal: AbortSignal,
) {
  const jwks = await oauthJson(codexIssuer + '/.well-known/jwks.json', signal)
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
    issuer: codexIssuer,
    audience: clientId,
    algorithms: ['RS256', 'ES256'],
    requiredClaims: ['sub', 'exp', 'iat'],
    clockTolerance: 5,
  })
  check(typeof payload.sub === 'string' && payload.sub.length > 0, '授权身份无效')
  check(nonce === undefined || payload.nonce === nonce, '授权身份校验失败，请重新登录')
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' }
}
