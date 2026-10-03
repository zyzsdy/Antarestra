# 主体、会话与 RBAC

`@antarestra/rbac` 提供认证与授权服务契约，依赖 `database`、`server`，通过 `ctx.rbac` 统一主体、认证实例、身份映射、会话与授权检查。`@antarestra/plugin-auth-local` 管理登录名和密码凭据，所有数据库操作都经过 database 插件；当前个人空间枚举还包含对该实现的显式识别，第三方身份源需扩展这一边界。

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
  ctx.rbac.registerPermission(ctx, 'report.document.read', '查看报告')
  ctx.server.route(
    ctx,
    'GET',
    '/reports',
    ctx.rbac.require('report.document.read'),
    async (http) => {
      const auth = ctx.rbac.auth(http)
      http.body = { principalId: auth.principalId }
    },
  )
}
```

空间业务通过 `require(permission, resolveScope)` 或 `can(auth, permission, scope)` 指定空间。必须从服务端资源记录解析空间并检查归属，不能相信客户端提交的 owner。默认范围是 `system`，不会自动覆盖工作空间。范围用 SHA-256 精确匹配，避免数据库排序规则混淆大小写。当前个人空间由 auth-local 映射，IM 空间和成员由 identity-im 管理；AI 会话与 workspace-file 分别检查自己的资源归属。

## 数据与权限

- RBAC 私有表：`principal`、`provider`、`identity`、`session`、`role`、`role_permission`、`binding`、`role_migration`。database 负责物理表名前缀和迁移历史。
- 身份按提供者实例与稳定 subject 唯一定位。local 使用账号 UUID，不按邮箱跨实例合并主体。
- 多角色权限取并集，绑定包含准确范围、来源和可选失效时间。角色或绑定修改立即影响后续请求；首版无权限缓存、角色继承、通配符或显式拒绝。
- 权限声明通过 `registerPermission(owner, key, description)` 绑定插件生命周期，重复注册拒绝。声明保存在运行期，角色授权持久保存；插件卸载后，其未声明的权限无法使用。
- `grantRole(transaction, input)` 是可信插件的内部装配能力，创建绑定前验证主体和角色存在。业务应先完成空间鉴权，不应直接将此接口暴露给客户端。
- database 当前迁移协议不提供外键，本版通过服务接口、唯一索引与跨插件事务维护关联，消费插件不得直接写 RBAC 私有表。

内置 `admin` 角色默认包含 `identity.local.manage`、`authz.role.manage`、`authz.binding.manage`，无隐式超级权限。RBAC 的角色编辑及绑定接口限制授予操作者自己拥有的权限；默认权限不能取消，本地禁用账号接口保护自身和内置管理员。auth-local 创建账号和重置密码尚有未应用同等限制的提权缺口，见[安全评审](../../../docs/reviews/2026-10-03.md)。手动撤销只影响 `manual` 来源，不覆盖初始化或其他插件的绑定。

## 接入认证实现

认证插件调用 `registerProvider(owner, providerId, pluginId)` 获得绑定该实例的句柄。通过 `handle.provision(transaction, stableSubject, displayName)` 创建主体与身份，通过 `handle.issue(stableSubject)` 为已验证的身份签发会话。插件必须先验证密码或外部凭证，不得把 issue 暴露为接受任意 subject 的公开 API。

会话使用 256 位随机令牌，数据库只保存 SHA-256。local 通过 HttpOnly、SameSite=Strict Cookie 传递，直接 HTTPS 时带 Secure，浏览器脚本不接触令牌，不写 localStorage。内部客户端可通过 `Authorization: Bearer` 携带已签发令牌。每次验证检查会话有效期、主体、身份、提供者状态与运行登记。

禁用账号撤销其会话；注销删除当前会话。提供者卸载立即撤销运行登记，主体与角色数据保留；重新注册提供者时清除旧会话，重载或进程重启后需要重新登录。首版按单个服务进程设计，不支持多副本共享会话在线状态。数据库账号与 Cordis 上下文不构成不可信插件隔离边界。

## HTTP 接口

| 方法 | 路径                              | 要求                                                       |
| ---- | --------------------------------- | ---------------------------------------------------------- |
| GET  | `/api/auth/me`                    | 已登录，返回主体、会话上下文和用于客户端展示的系统权限快照 |
| POST | `/api/auth/logout`                | 已登录，JSON `{}`                                          |
| GET  | `/api/rbac/roles`                 | `authz.role.manage`，包含可用权限声明                      |
| PUT  | `/api/rbac/roles/:id`             | `authz.role.manage`，JSON `{name, permissions}`            |
| GET  | `/api/rbac/bindings/:principalId` | `authz.binding.manage`                                     |
| PUT  | `/api/rbac/bindings/:principalId` | `authz.binding.manage`，JSON `{roleId, scope, enabled}`    |

写接口限定 JSON、最多 16 KiB，并检查 Origin 和跨站 Fetch Metadata。反向代理终止 HTTPS、跨域嵌入、SSO 尚未适配，本版使用 server 直接 HTTPS 或本机开发 HTTP。

## 请求通道与默认角色

权限注册使用 `registerPermission(owner, name, description, defaultRoles)`，默认角色可选 `guest`（未登录）、`user`（已登录）、`admin`（管理员）。默认角色按每次请求解析，不为新功能批量写入角色绑定。管理员不是全权限角色，仍需权限声明包含 `admin` 或已有显式授权。

`registerRequestSource(owner, source, provider)` 注册通道，`source` 是提供方与消费方约定的自由字符串，例如 `web`、`qqgroup`、`telegram_group`。提供者包含唯一 `id`、可选登录路径及异步 `resolve(request)`，负责验证凭据、成员关系并返回可信 `actorId`、`workspaceId` 和角色；不匹配时返回 `undefined`。同通道可以注册不同提供者，多方同时认领身份时拒绝请求。通道卸载后调用失败。

消费方使用 `resolveRequest(source, request)` 解析身份，或 `authorizeRequest(source, request, permission)` 同时鉴权。后者在提供者已验证的空间内应用默认角色，并支持 Web 会话在该空间的显式角色授权。不得把客户端传来的角色和空间直接作为解析结果。无身份时默认角色为 `guest`，无通道时返回 503。

`web` 由 auth-local 提供：Actor 对应现有 principal ID；个人空间稳定映射为 `personal:<actorId>`。IM 通道由 identity-im 映射空间并校验成员，聊天数据由 AI 核心持久化。当前网页登录仍没有通用共享空间切换和成员管理。`can` / `require` 在 `system` 范围支持已登录默认角色；空间默认权限应通过 `authorizeRequest` 在经过提供者验证的空间内判定，系统授权不覆盖任意空间。

内置角色统一为 `admin`、`user`、`guest`。启动时事务迁移旧 `administrator` 的绑定及额外授权，默认权限不写入数据库。内置角色可以编辑名称和额外权限，默认权限不能取消。三个管理权限的默认角色均为 admin，其描述分别明确用户查询及启停、角色权限配置、用户角色绑定用途。

`GET /api/rbac/role-options` 供拥有 `authz.binding.manage` 的操作者选择角色，返回 ID 与名称。绑定写接口允许创建新的合法角色 ID（初始无额外权限），同时校验目标角色的默认权限及额外权限，防止通过绑定默认角色越权。撤销只影响 manual 来源。

迁移首次执行时，旧版本已存在的 admin、user、guest 自定义角色会改名为 legacy-原ID-随机UUID，保留其名称、绑定及额外授权，避免同名角色意外升级为默认角色。迁移标记与数据变更同事务保存。

默认角色的额外授权在已验证的请求通道内与默认声明取并集；system 范围的 can/require 对已登录默认角色应用同样规则。自定义角色仍只在绑定的准确范围内生效。匿名请求不会获得 user 或 admin。用户目录批量读取主体与角色以避免逐账号查询，当前在服务端组合过滤后分页，适用于现阶段的本地用户管理。
