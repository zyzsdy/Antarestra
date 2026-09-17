# 本地认证插件

提供邮箱密码登录、注册、用户状态管理和共享角色管理界面。默认配置已启用，启动服务后打开 `http://127.0.0.1:14451/auth/user/`。页面由 WebUI 扩展提供，随插件卸载撤销。

## 配置与管理员初始化

```yaml
plugin-auth-local:
  providerId: local
  allowRegistration: true
  bootstrapEmail: admin@example.com
  bootstrapPassword: $ANTARESTRA_ADMIN_PASSWORD
```

`providerId` 为 1–64 位小写字母、数字或连字符，首字符必须是字母。多实例使用不同 providerId，URL 包含该标识。省略 `allowRegistration` 时默认关闭注册；项目演示配置显式开启。

启动前设置 `ANTARESTRA_ADMIN_PASSWORD` 为自己选择的 8–128 字符密码。启动只在邮箱不存在时创建管理员，在同一事务中写入主体、身份、本地凭据和管理员角色。已存在的同名账号不会被提升权限或覆盖密码。初始化完成后可移除两个 bootstrap 配置项及环境变量。不要先公开注册预定的管理员邮箱。

密码采用随机盐与 scrypt（N=32768、r=8、p=3），不存明文。邮箱按 NFKC、去除首尾空格、小写规范化，只作为登录名，每个认证实例内独立唯一。邮箱验证、密码找回与修改、MFA、SSO 和群聊适配尚未实现。密码长度要求为 8–128 个字符。

## 页面与 API

账号页面 `/auth/user/`（其他实例为 `/auth/user/:providerId/`）包含登录与注册；用户、角色及授权管理位于 `/admin/`。注册不自动登录，也不授予角色。用户列表每页 50 个，只返回当前认证实例账号，不返回密码哈希。

| 方法 | 路径（前缀 `/api/auth/local/:providerId`） | 请求或要求                                                  |
| ---- | ------------------------------------------ | ----------------------------------------------------------- |
| POST | `/register`                                | `{email, password, displayName}`，需开启注册                |
| POST | `/login`                                   | `{email, password}`，成功设置 Cookie                        |
| GET  | `/users?offset=0`                          | `identity.local.manage`                                     |
| PUT  | `/users/:accountId/status`                 | `identity.local.manage`，`{status: 'active' 或 'disabled'}` |

登录凭据错误统一返回“邮箱或密码错误”；注册重复邮箱返回 409。单实例对同一来源 IP 每分钟最多接受 20 次登录或注册请求，同时最多进行两次密码计算。限流保存在进程内，多副本需要外部限流设施。

local 通过 database 跨插件事务和 RBAC 服务写入身份，自己只操作 account 私有表。账号重复或创建失败时整体回滚，不产生孤立主体。卸载不删除账号，重载要求重新登录。

## 页面扩展

本插件依赖 webui，通过客户端入口注册 Vue 页面。默认实例页面为 /auth/user/，其他实例为 /auth/user/<providerId>/。前端构建输出到 public/，由 WebUI 注册资源；认证 API 路径保持不变。页面与导航随插件卸载回收。详见 [WebUI 说明](../../definitions/webui/README.md)。

## Web 请求通道

本插件注册 RBAC 的 `web` 请求通道。验证 Cookie 或 Bearer 会话后返回 actorId、稳定个人 workspaceId 和默认角色。普通登录者为 `user`，有效系统管理员绑定额外提供 `admin`。多个本地认证实例仅认领自己的会话。新功能声明的默认权限即时生效，无需手动分配。

从聊天入口跳转的登录页面带有 `returnTo=/`；登录成功返回首页，只接受该固定返回目标。其他请求继续留在账号中心。

## 后台管理页面

用户与权限管理已迁移到 `/admin/` 下的独立页面：本地用户、角色与权限、角色分配。账号页继续负责登录、注册、退出和个人身份展示。登录支持返回后台的安全站内路径。

客户端通过 `@antarestra/plugin-admin-console/client` 注册页面插槽。未启用 admin-console 时仅保留账号页；多个 local 实例使用各自的菜单分组与用户列表。后台入口检查 `admin.console.view`，各管理页面继续检查原有操作权限。

本地用户支持 `q`（用户名、邮箱、主体标识）、`status`、`role` 精确角色 ID 筛选以及 `offset` 分页；响应为 `{ users, total }`，每个用户携带主体资料及当前角色。筛选先于分页。角色分配已整合到用户行弹窗，不再提供独立分配页面。
