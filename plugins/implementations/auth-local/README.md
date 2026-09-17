# 本地认证插件

提供登录名密码登录、管理员创建与重置用户、自助注册、强制修改初始密码、用户状态管理和共享角色管理界面。默认配置已启用，启动服务后打开 `http://127.0.0.1:14451/auth/user/`。页面由 WebUI 扩展提供，随插件卸载撤销。

## 配置与管理员初始化

```yaml
plugin-auth-local:
  providerId: local
  allowRegistration: false
  bootstrapEmail: admin@example.com
  bootstrapPassword: $ANTARESTRA_ADMIN_PASSWORD
```

`providerId` 为 1–64 位小写字母、数字或连字符，首字符必须是字母。多实例使用不同 providerId，URL 包含该标识。省略 `allowRegistration` 时默认关闭注册；只有显式设置为 `true` 才显示自助注册入口并接受注册请求。

启动前设置 `ANTARESTRA_ADMIN_PASSWORD` 为自己选择的 8–128 字符密码。启动只在登录名不存在时创建管理员，在同一事务中写入主体、身份、本地凭据和管理员角色。已存在的同名账号不会被提升权限或覆盖密码。初始化完成后可移除两个 bootstrap 配置项及环境变量。不要先注册预定的管理员登录名。

密码采用随机盐与 scrypt（N=32768、r=8、p=3），不存明文。登录名按 NFKC、去除首尾空格、小写规范化，每个认证实例内独立唯一，并继续兼容原有邮箱登录名。管理员创建或重置账号时生成 16 位、包含小写字母/数字/易辨识符号的初始密码；明文只在响应和弹窗中出现一次，数据库仅保存哈希与“必须修改密码”标志。密码长度要求为 8–128 个字符，区分大小写。邮箱验证、密码找回、MFA、SSO 和群聊适配尚未实现。

## 页面与 API

账号页面 `/auth/user/`（其他实例为 `/auth/user/:providerId/`）包含登录、按配置显示的注册入口和用户中心；修改密码页面位于其下的 `change-password/`。用户、角色及授权管理位于 `/admin/`。注册不自动登录，登录后获得默认 `user` 角色。用户列表每页 50 个，只返回当前认证实例账号，不返回密码哈希。

| 方法 | 路径（前缀 `/api/auth/local/:providerId`） | 请求或要求                                                  |
| ---- | ------------------------------------------ | ----------------------------------------------------------- |
| POST | `/register`                                | `{loginName, password, displayName}`，需开启注册            |
| POST | `/login`                                   | `{loginName, password}`，成功设置 Cookie                    |
| GET  | `/account`                                 | 当前账号的登录名及是否必须修改密码                          |
| POST | `/password`                                | `{currentPassword, newPassword}`，修改当前账号密码          |
| POST | `/users`                                   | 创建用户、分配初始角色并返回一次性初始登录信息              |
| GET  | `/users?offset=0`                          | `identity.local.manage`                                     |
| PUT  | `/users/:accountId/status`                 | `identity.local.manage`，`{status: 'active' 或 'disabled'}` |
| POST | `/users/:accountId/reset-password`         | 重置密码、撤销旧会话并返回一次性初始登录信息                |

登录凭据错误统一返回“登录名或密码错误”；注册重复登录名返回 409。单实例对同一来源 IP 每分钟最多接受 20 次登录或注册请求，同时最多进行两次密码计算。限流保存在进程内，多副本需要外部限流设施。

local 通过 database 跨插件事务和 RBAC 服务写入身份，自己只操作 account 私有表。账号重复或创建失败时整体回滚，不产生孤立主体。卸载不删除账号，重载要求重新登录。

## 页面扩展

本插件依赖 webui，通过客户端入口注册 Vue 页面。默认实例页面为 /auth/user/，其他实例为 /auth/user/<providerId>/。前端构建输出到 public/，由 WebUI 注册资源；认证 API 路径保持不变。页面与导航随插件卸载回收。详见 [WebUI 说明](../../definitions/webui/README.md)。

## Web 请求通道

本插件注册 RBAC 的 `web` 请求通道。验证 Cookie 或 Bearer 会话后返回 actorId、稳定个人 workspaceId 和默认角色。普通登录者为 `user`，有效系统管理员绑定额外提供 `admin`。多个本地认证实例仅认领自己的会话。新功能声明的默认权限即时生效，无需手动分配。

从聊天入口跳转的登录页面带有 `returnTo=/`；登录成功返回首页，只接受该固定返回目标。其他请求继续留在账号中心。

## 后台管理页面

用户与权限管理已迁移到 `/admin/` 下的独立页面：本地用户、角色与权限、角色分配。账号页继续负责登录、注册、退出和个人身份展示。登录支持返回后台的安全站内路径。

客户端通过 `@antarestra/plugin-admin-console/client` 注册页面插槽。未启用 admin-console 时仅保留账号页；多个 local 实例使用各自的菜单分组与用户列表。后台入口检查 `admin.console.view`，各管理页面继续检查原有操作权限。

本地用户支持 `q`（用户名、登录名、主体标识）、`status`、`role` 精确角色 ID 筛选以及 `offset` 分页；响应为 `{ users, total }`，每个用户携带主体资料及当前角色。筛选先于分页。角色分配已整合到用户行弹窗，不再提供独立分配页面。
