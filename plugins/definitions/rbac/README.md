# 主体、会话与 RBAC

`@antarestra/rbac` 是不依赖具体认证方式的定义插件。它依赖 `database`、`server`，提供 `ctx.rbac`：统一主体、认证实例、身份映射、会话与授权检查。`@antarestra/plugin-auth-local` 只拥有邮箱和密码凭据，所有数据库操作都经过现有 database 插件。

## 装配与请求规则

```yaml
plugins:
  database: {}
  plugin-database-kysely: {}
  plugin-server: {}
  rbac:
    sessionHours: 24
  plugin-auth-local:
    providerId: local
    allowRegistration: true
```

启用后，`/api` 及其下所有 API 默认要求登录；健康接口和认证插件显式登记的注册、登录接口例外。业务插件必须声明 `inject: ['rbac', 'server']`，使用 `ctx.rbac.require()` 执行具体权限检查。卸载 RBAC 或数据库会撤销依赖它们的路由，不能省略依赖声明。

认证失败返回 401，权限不足返回 403，提供者异常不会放行。数据库异常沿用 server 的 500 处理。认证结果放在服务私有请求映射中，通过 `ctx.rbac.auth(http)` 读取，不信任请求中的主体 ID、角色或 `state.auth`。

```typescript
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/rbac'

export const inject = ['rbac', 'server']
export function apply(ctx: Context) {
  ctx.rbac.registerPermission(ctx, 'report.read', '查看报告')
  ctx.server.route(ctx, 'GET', '/reports', ctx.rbac.require('report.read'), async (http) => {
    const auth = ctx.rbac.auth(http)
    http.body = { principalId: auth.principalId }
  })
}
```

空间业务通过 `require(permission, resolveScope)` 或 `can(auth, permission, scope)` 指定空间。必须从服务端资源记录解析空间并检查归属，不能相信客户端提交的 owner。默认范围是 `system`，不会自动覆盖工作空间。范围用 SHA-256 精确匹配，避免数据库排序规则混淆大小写。工作空间创建、成员资格与资源归属仍由未来业务插件实现。

## 数据与权限

- RBAC 私有表：`principal`、`provider`、`identity`、`session`、`role`、`role_permission`、`binding`。database 负责物理表名前缀和迁移历史。
- 身份按提供者实例与稳定 subject 唯一定位。local 使用账号 UUID，不按邮箱跨实例合并主体。
- 多角色权限取并集，绑定包含准确范围、来源和可选失效时间。角色或绑定修改立即影响后续请求；首版无权限缓存、角色继承、通配符或显式拒绝。
- 权限声明通过 `registerPermission(owner, key, description)` 绑定插件生命周期，重复注册拒绝。声明保存在运行期，角色授权持久保存；插件卸载后，其未声明的权限无法使用。
- `grantRole(transaction, input)` 是可信插件的内部装配能力，创建绑定前验证主体和角色存在。业务应先完成空间鉴权，不应直接将此接口暴露给客户端。
- database 当前迁移协议不提供外键，本版通过服务接口、唯一索引与跨插件事务维护关联，消费插件不得直接写 RBAC 私有表。

内置 `administrator` 角色包含 `identity.local.manage`、`authz.role.manage`、`authz.binding.manage`，无隐式超级权限。管理接口不能授予操作者自己没有的权限，也不能修改内置管理员角色、禁用自己或通过本地管理禁用内置管理员。手动撤销只影响 `manual` 来源，不覆盖初始化或其他插件的绑定。

## 接入认证实现

认证插件调用 `registerProvider(owner, providerId, pluginId)` 获得绑定该实例的句柄。通过 `handle.provision(transaction, stableSubject, displayName)` 创建主体与身份，通过 `handle.issue(stableSubject)` 为已验证的身份签发会话。插件必须先验证密码或外部凭证，不得把 issue 暴露为接受任意 subject 的公开 API。

会话使用 256 位随机令牌，数据库只保存 SHA-256。local 通过 HttpOnly、SameSite=Strict Cookie 传递，直接 HTTPS 时带 Secure，浏览器脚本不接触令牌，不写 localStorage。内部客户端可通过 `Authorization: Bearer` 携带已签发令牌。每次验证检查会话有效期、主体、身份、提供者状态与运行登记。

禁用账号撤销其会话；注销删除当前会话。提供者卸载立即撤销运行登记，主体与角色数据保留；重新注册提供者时清除旧会话，重载或进程重启后需要重新登录。首版按单个服务进程设计，不支持多副本共享会话在线状态。数据库账号与 Cordis 上下文不构成不可信插件隔离边界。

## HTTP 接口

| 方法 | 路径                              | 要求                                                    |
| ---- | --------------------------------- | ------------------------------------------------------- |
| GET  | `/api/auth/me`                    | 已登录，返回主体与会话上下文                            |
| POST | `/api/auth/logout`                | 已登录，JSON `{}`                                       |
| GET  | `/api/rbac/roles`                 | `authz.role.manage`，包含可用权限声明                   |
| PUT  | `/api/rbac/roles/:id`             | `authz.role.manage`，JSON `{name, permissions}`         |
| GET  | `/api/rbac/bindings/:principalId` | `authz.binding.manage`                                  |
| PUT  | `/api/rbac/bindings/:principalId` | `authz.binding.manage`，JSON `{roleId, scope, enabled}` |

写接口限定 JSON、最多 16 KiB，并检查 Origin 和跨站 Fetch Metadata。反向代理终止 HTTPS、跨域嵌入、SSO 尚未适配，本版使用 server 直接 HTTPS 或本机开发 HTTP。
