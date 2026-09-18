import type { Context } from '@antarestra/plugin-sdk'
import { ManagementError } from '@antarestra/config-loader'
import type { Operation, PanelLayout } from '@antarestra/config-loader'
import { AuthError, readJson, textField } from '@antarestra/rbac'
import type { HttpContext } from '@antarestra/plugin-server'
import '@antarestra/webui'
import { fileURLToPath } from 'node:url'

export const name = '@antarestra/plugin-config-panel'
export const inject = ['webui', 'server', 'rbac', 'configManager']
export function apply(ctx: Context) {
  ctx.webui.addEntry(ctx, {
    id: 'config-panel',
    directory: fileURLToPath(new URL('../public/', import.meta.url)),
  })
  const base = '/plugin-config-panel'
  const manager = ctx.configManager
  const afterResponse = (http: HttpContext) =>
    new Promise<void>((resolve) => {
      if (http.res.writableFinished || http.res.destroyed) return resolve()
      const finish = () => {
        http.res.off('finish', finish)
        http.res.off('close', finish)
        resolve()
      }
      http.res.once('finish', finish)
      http.res.once('close', finish)
    })
  const route = (
    method: string,
    path: string,
    action: (http: HttpContext) => Promise<void>,
    permission = 'admin.plugins.manage',
  ) => {
    ctx.server.route(
      ctx,
      method,
      base + path,
      ctx.rbac.require('admin.console.view'),
      ctx.rbac.require(permission),
      async (http) => {
        http.set('Cache-Control', 'no-store')
        try {
          await action(http)
        } catch (error) {
          if (error instanceof ManagementError) throw new AuthError(error.status, error.message)
          throw error
        }
      },
    )
  }
  const queue = (http: HttpContext, action: (operation: Operation) => Promise<void>) => {
    http.status = 202
    const auth = ctx.rbac.auth(http)
    const rbac = ctx.rbac
    http.body = manager.enqueue(async (operation) => {
      if (!(await rbac.can(auth, 'admin.plugins.manage')))
        throw new ManagementError(403, '权限或会话已失效')
      await action(operation)
    }, afterResponse(http))
  }
  route('GET', '', async (http) => {
    http.body = await manager.snapshot()
  })
  route('GET', '/catalog', async (http) => {
    http.body = await manager.catalog()
  })
  route('GET', '/instances/:id', async (http) => {
    http.body = await manager.detail(textField(http.params.id, '实例标识', 250))
  })
  route('GET', '/operations/:id', async (http) => {
    const operation = manager.operation(textField(http.params.id, '操作标识'))
    http.body = {
      ...operation,
      ...(['completed', 'failed'].includes(operation.state)
        ? { snapshot: await manager.snapshot() }
        : {}),
    }
  })
  route('POST', '/instances', async (http) => {
    const body = await readJson(http, 262144)
    const version = textField(body.version, '配置版本')
    const name = textField(body.name, '插件包名', 214)
    queue(http, (operation) => manager.add(version, name, operation))
  })
  route('PUT', '/instances/:id', async (http) => {
    const body = await readJson(http, 262144)
    if (
      typeof body.yaml !== 'string' ||
      typeof body.alias !== 'string' ||
      typeof body.enabled !== 'boolean'
    )
      throw new AuthError(400, '配置、别名及启用状态无效')
    const version = textField(body.version, '配置版本')
    const id = textField(http.params.id, '实例标识', 250)
    const { yaml, alias, enabled } = body
    queue(http, (operation) => manager.save(version, id, yaml, enabled, alias, operation))
  })
  route('DELETE', '/instances/:id', async (http) => {
    const body = await readJson(http)
    const version = textField(body.version, '配置版本')
    const id = textField(http.params.id, '实例标识', 250)
    queue(http, (operation) => manager.remove(version, id, operation))
  })
  route('POST', '/instances/:id/apply', async (http) => {
    const body = await readJson(http)
    const version = textField(body.version, '配置版本')
    const id = textField(http.params.id, '实例标识', 250)
    queue(http, () => manager.applyDisk(version, id))
  })
  route('PUT', '/layout', async (http) => {
    const body = await readJson(http, 262144)
    const version = textField(body.version, '配置版本')
    queue(http, (operation) => manager.layout(version, body.layout as PanelLayout, operation))
  })
  route('PUT', '/loader', async (http) => {
    const body = await readJson(http)
    const version = textField(body.version, '配置版本')
    queue(http, (operation) => manager.loaderSettings(version, body.settings, operation))
  })
  route(
    'GET',
    '/restart',
    async (http) => {
      http.body = { generation: manager.generation, processId: process.pid }
    },
    'admin.system.restart',
  )
  route(
    'POST',
    '/restart',
    async (http) => {
      const body = await readJson(http)
      if (typeof body.password !== 'string') throw new AuthError(400, '请输入当前账号密码')
      await ctx.rbac.reauthenticate(http, body.password)
      http.status = 202
      http.body = manager.requestRestart(afterResponse(http))
    },
    'admin.system.restart',
  )
}
