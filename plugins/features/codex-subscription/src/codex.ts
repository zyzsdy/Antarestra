import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { Server } from 'node:http'
import type { Context } from '@antarestra/plugin-sdk'
import { AiError } from '@antarestra/ai'
import type { ModelContext } from '@antarestra/ai'
import { AuthError } from '@antarestra/rbac'
import { check } from './validation.js'
import { codexDriver } from './driver.js'
import { CodexStorage } from './codex-storage.js'
import { codexModels, codexProvider } from './codex-models.js'
import {
  authorizationUrl,
  codexIssuer,
  exchangeTokens,
  oauthJson,
  parseTokens,
  randomOAuthValue,
  verifyIdentity,
} from './codex-oauth.js'
import type { CodexAccount, CodexAccountView, CodexLoginView, CodexState } from './codex-types.js'

interface Attempt extends CodexLoginView {
  ownerId: string
  accountId: string | undefined
  state: string
  nonce: string
  verifier: string
  server: Server
  timer: ReturnType<typeof setTimeout>
}
const safeError = (error: unknown) =>
  error instanceof AuthError ? error.message : '订阅操作失败，请检查网络或重新授权'

export class CodexSubscriptions {
  private storage: CodexStorage
  private state: CodexState = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] }
  private queue: Promise<unknown> = Promise.resolve()
  private controller = new AbortController()
  private attempts = new Map<string, Attempt>()
  private registrations = new Map<string, () => Promise<void>>()
  private ready = false
  constructor(
    private ctx: Context,
    directory: string,
  ) {
    this.storage = new CodexStorage(directory)
    ctx.effect(() => async () => {
      this.controller.abort()
      await Promise.all([...this.attempts.values()].map((attempt) => this.closeAttempt(attempt)))
      await this.queue
      for (const dispose of this.registrations.values()) await dispose()
      this.registrations.clear()
      this.attempts.clear()
      this.state.accounts = []
      await this.storage.close()
    })
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      this.controller.signal.throwIfAborted()
      return action()
    })
    this.queue = result.catch(() => {})
    return result
  }
  async initialize() {
    const saved = await this.storage.read()
    if (!saved) return
    await this.storage.lock()
    this.state = (await this.storage.read()) ?? saved
    this.ready = true
    for (const account of this.state.accounts) this.register(account)
  }
  private async prepare() {
    if (this.ready) return
    await this.storage.lock()
    this.state = (await this.storage.read()) ?? this.state
    await this.storage.write(this.state)
    this.ready = true
  }
  private account(ownerId: string, id: string) {
    const account = this.state.accounts.find(
      (entry) => entry.id === id && entry.ownerId === ownerId,
    )
    if (!account) throw new AuthError(404, '订阅账户不存在')
    return account
  }
  list(ownerId: string): CodexAccountView[] {
    return this.state.accounts
      .filter((account) => account.ownerId === ownerId)
      .map((account) => ({
        id: account.id,
        email: account.email,
        clientId: account.clientId,
        connected: !!account.tokens,
        expiresAt: account.tokens?.expiresAt ?? null,
        models: structuredClone(account.models),
      }))
  }
  private register(account: CodexAccount) {
    if (!account.tokens) return
    const record = codexProvider(account)
    const removeDriver = this.ctx.ai.registerDriver(this.ctx, codexDriver(record))
    try {
      const removeProvider = this.ctx.ai.registerProvider(this.ctx, {
        id: account.id,
        title: record.name,
        baseUrl: record.baseUrl,
        driverId: `ai-provider:${account.id}`,
        models: account.models,
        resolveCredential: (context) => this.credential(account.id, context),
      })
      this.registrations.set(account.id, async () => {
        await removeProvider()
        await removeDriver()
      })
    } catch (error) {
      void removeDriver()
      throw error
    }
  }
  private async commit(account: CodexAccount) {
    const accounts = this.state.accounts.filter((entry) => entry.id !== account.id)
    accounts.push(account)
    const next = { ...this.state, accounts }
    await this.storage.write(next)
    this.state = next
    await this.registrations.get(account.id)?.()
    this.registrations.delete(account.id)
    this.register(account)
  }
  private async accessToken(account: CodexAccount) {
    const previous = account.tokens
    if (!previous) throw new AuthError(409, '订阅已断开，请重新授权')
    if (previous.expiresAt > Date.now() + 60_000) return previous.accessToken
    const body = await exchangeTokens(
      {
        grant_type: 'refresh_token',
        client_id: account.clientId,
        refresh_token: previous.refreshToken,
      },
      this.controller.signal,
    )
    const tokens = parseTokens(body, previous)
    if (body.id_token !== undefined) {
      const identity = await verifyIdentity(
        tokens.idToken,
        account.clientId,
        undefined,
        this.controller.signal,
      )
      check(identity.subject === account.subject, '刷新后的账户身份不一致，请重新授权')
    }
    // 刷新只替换凭据，不卸载正在进行的模型调用。
    const next = {
      ...this.state,
      accounts: this.state.accounts.map((entry) =>
        entry.id === account.id ? { ...account, tokens } : entry,
      ),
    }
    await this.storage.write(next)
    this.state = next
    return tokens.accessToken
  }
  credential(id: string, context: ModelContext) {
    const pending = this.lock(async () => {
      context.signal.throwIfAborted()
      const account = this.state.accounts.find((entry) => entry.id === id)
      if (!account || account.ownerId !== context.actorId)
        throw new AiError('subscription_access_denied', '只能使用本人授权的 ChatGPT 订阅', 403)
      const token = await this.accessToken(account)
      context.signal.throwIfAborted()
      return token
    })
    // 注册回收会等待运行结束；排队取凭据的运行必须能够立即响应取消，避免锁互等。
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(context.signal.reason ?? new Error('模型调用已取消'))
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
      void pending
        .then(resolve, reject)
        .finally(() => context.signal.removeEventListener('abort', abort))
    })
  }
  begin(ownerId: string, accountId?: string) {
    return this.lock(async () => {
      await this.prepare()
      const account = accountId ? this.account(ownerId, accountId) : undefined
      for (const attempt of this.attempts.values()) {
        if (attempt.ownerId === ownerId) {
          await this.closeAttempt(attempt)
          this.attempts.delete(attempt.id)
        }
      }
      check(this.attempts.size < 50, '待授权请求过多，请稍后重试')
      const id = randomUUID()
      const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Referrer-Policy', 'no-referrer')
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        const attempt = this.attempts.get(id)
        if (!attempt || request.method !== 'GET' || !request.url?.startsWith('/auth/callback?')) {
          response.writeHead(404).end('授权回调不存在')
          return
        }
        const callback = attempt.redirectUri + request.url.slice('/auth/callback'.length)
        void Promise.resolve()
          .then(() => this.complete(ownerId, id, callback))
          .then(
            () => response.end('授权成功，请关闭此页面并返回 Antarestra 控制台。'),
            (error: unknown) => response.writeHead(400).end(safeError(error)),
          )
      })
      server.headersTimeout = 5000
      server.requestTimeout = 10000
      server.on('error', () => {})
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (this.controller.signal.aborted) {
        server.close()
        this.controller.signal.throwIfAborted()
      }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动 OAuth 回调')
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const state = randomOAuthValue(),
        nonce = randomOAuthValue(),
        verifier = randomOAuthValue()
      const attempt: Attempt = {
        id,
        ownerId,
        accountId,
        state,
        nonce,
        verifier,
        server,
        redirectUri,
        url: authorizationUrl({
          ...(account ? { clientId: account.clientId } : {}),
          hostId: this.state.hostId,
          redirectUri,
          state,
          nonce,
          verifier,
        }),
        expiresAt: Date.now() + 600_000,
        status: 'pending',
        error: '',
        timer: setTimeout(() => {
          if (attempt.status === 'pending') {
            attempt.status = 'failed'
            attempt.error = '授权已过期，请重新开始'
          }
          void this.closeAttempt(attempt)
          this.attempts.delete(id)
        }, 600_000),
      }
      attempt.timer.unref()
      this.attempts.set(id, attempt)
      return this.loginView(attempt)
    })
  }
  private loginView(attempt: Attempt): CodexLoginView {
    return {
      id: attempt.id,
      url: attempt.url,
      redirectUri: attempt.redirectUri,
      expiresAt: attempt.expiresAt,
      status: attempt.status,
      error: attempt.error,
    }
  }
  status(ownerId: string, id: string) {
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.ownerId !== ownerId)
      throw new AuthError(404, '授权已过期或不存在，请重新开始')
    return this.loginView(attempt)
  }
  private async closeAttempt(attempt: Attempt) {
    clearTimeout(attempt.timer)
    if (!attempt.server.listening) return
    await new Promise<void>((resolve) => {
      attempt.server.close(() => resolve())
      attempt.server.closeAllConnections()
    })
  }
  complete(ownerId: string, id: string, callback: string) {
    // 先原子消费 state，再进入串行队列，阻止重复回调交换同一授权码。
    const attempt = this.attempts.get(id)
    check(
      attempt &&
        attempt.ownerId === ownerId &&
        attempt.status === 'pending' &&
        attempt.expiresAt > Date.now(),
      '授权已过期或已处理',
    )
    let url: URL
    try {
      url = new URL(callback)
    } catch {
      throw new AuthError(400, '请输入完整的回调地址')
    }
    check(
      url.origin + url.pathname === attempt.redirectUri &&
        !url.username &&
        !url.password &&
        !url.hash,
      '回调地址与本次授权不匹配',
    )
    check(
      url.searchParams.getAll('state').length === 1 &&
        url.searchParams.get('state') === attempt.state,
      '授权 state 不匹配，请使用本次登录的回调地址',
    )
    attempt.status = 'exchanging'
    clearTimeout(attempt.timer)
    return this.lock(async () => {
      try {
        check(!url.searchParams.has('error'), '授权已取消或被拒绝，请重新登录并允许订阅访问')
        const previous = attempt.accountId ? this.account(ownerId, attempt.accountId) : undefined
        check(url.searchParams.getAll('client_id').length <= 1, '客户端 ID 参数重复')
        const clientId = url.searchParams.get('client_id') ?? previous?.clientId
        check(clientId && /^oaiapp_[\w-]+$/.test(clientId), '授权未返回有效的客户端 ID，请重新注册')
        check(!previous || clientId === previous.clientId, '返回的客户端 ID 与账户不匹配')
        const code = url.searchParams.get('code')
        check(
          code && code.length <= 8192 && url.searchParams.getAll('code').length === 1,
          '授权码无效',
        )
        const body = await exchangeTokens(
          {
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirectUri,
          },
          this.controller.signal,
        )
        const tokens = parseTokens(body)
        const identity = await verifyIdentity(
          tokens.idToken,
          clientId,
          attempt.nonce,
          this.controller.signal,
        )
        check(!previous || identity.subject === previous.subject, '登录账户与原账户不匹配')
        check(
          !this.state.accounts.some(
            (entry) => entry.clientId === clientId && entry.id !== previous?.id,
          ),
          '此客户端已绑定，请使用已有账户重新授权',
        )
        const account: CodexAccount = {
          id: previous?.id ?? `codex-${randomUUID()}`,
          ownerId,
          clientId,
          ...identity,
          tokens,
          models: previous?.models ?? [],
        }
        // 目录暂时失败不丢失已完成的授权，面板提供独立重试。
        try {
          account.models = await codexModels(tokens.accessToken, this.controller.signal)
        } catch {
          this.controller.signal.throwIfAborted()
        }
        await this.commit(account)
        attempt.status = 'completed'
        return { success: true }
      } catch (error) {
        attempt.status = 'failed'
        attempt.error = safeError(error)
        throw new AuthError(400, attempt.error)
      } finally {
        attempt.verifier = attempt.nonce = attempt.state = ''
        attempt.url = ''
        if (!this.controller.signal.aborted) {
          // 回调已在有效期内消费，验证期间不再触发原登录超时；终态短期保留供面板读取。
          attempt.timer = setTimeout(() => this.attempts.delete(id), 600_000)
          attempt.timer.unref()
        }
        // 先让回调 HTTP 响应完成；监听器只接受已消费的状态，随后立即关闭。
        attempt.server.close()
        attempt.server.closeIdleConnections()
      }
    })
  }
  cancel(ownerId: string, id: string) {
    return this.lock(async () => {
      const attempt = this.attempts.get(id)
      check(attempt && attempt.ownerId === ownerId, '授权不存在')
      await this.closeAttempt(attempt)
      this.attempts.delete(id)
      return { success: true }
    })
  }
  sync(ownerId: string, id: string) {
    return this.lock(async () => {
      const account = this.account(ownerId, id)
      const token = await this.accessToken(account)
      const models = await codexModels(token, this.controller.signal)
      await this.commit({ ...this.account(ownerId, id), models })
      return this.list(ownerId)
    })
  }
  disconnect(ownerId: string, id: string) {
    return this.lock(async () => {
      const account = this.account(ownerId, id)
      // 先停止该提供商的运行，防止注销期间继续使用旧凭据。
      await this.registrations.get(id)?.()
      this.registrations.delete(id)
      let revoked = !account.tokens
      if (account.tokens) {
        try {
          const discovery = await oauthJson(
            codexIssuer + '/.well-known/openid-configuration',
            this.controller.signal,
          )
          const endpoint = new URL(String(discovery.revocation_endpoint))
          check(
            endpoint.origin === codexIssuer && !endpoint.username && !endpoint.password,
            '撤销端点无效',
          )
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt) await delay(250, undefined, { signal: this.controller.signal })
            try {
              const response = await fetch(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token: account.tokens.refreshToken,
                  token_type_hint: 'refresh_token',
                  client_id: account.clientId,
                }),
              })
              await response.body?.cancel()
              if (response.status === 200) {
                revoked = true
                break
              }
              if (response.status < 500) break
            } catch {
              this.controller.signal.throwIfAborted()
            }
          }
        } catch {
          /* 本地断开仍然清理令牌，并明确远端撤销结果。 */
        }
      }
      for (const attempt of this.attempts.values()) {
        if (attempt.accountId === id) {
          await this.closeAttempt(attempt)
          this.attempts.delete(attempt.id)
        }
      }
      const { tokens: _tokens, ...disconnected } = account
      await this.commit(disconnected)
      return {
        revoked,
        message: revoked
          ? '已断开订阅'
          : '已清除本地凭据，但未确认远端撤销。请在 ChatGPT 设置中断开此应用。',
      }
    })
  }
}
