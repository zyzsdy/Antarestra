# 本地认证插件

提供邮箱密码登录、注册、用户状态管理和共享角色管理界面。默认配置已启用，启动服务后打开 `http://127.0.0.1:14451/auth/local/local`。页面由插件提供，随插件卸载撤销，不依赖尚未接入后端的 Vue 页面壳。

## 配置与管理员初始化

```yaml
plugin-auth-local:
  providerId: local
  allowRegistration: true
  bootstrapEmail: admin@example.com
  bootstrapPasswordEnv: ANTARESTRA_ADMIN_PASSWORD
```

`providerId` 为 1–64 位小写字母、数字或连字符，首字符必须是字母。多实例使用不同 providerId，URL 包含该标识。省略 `allowRegistration` 时默认关闭注册；项目演示配置显式开启。

启动前设置 `ANTARESTRA_ADMIN_PASSWORD` 为自己选择的 12–128 字符密码。启动只在邮箱不存在时创建管理员，在同一事务中写入主体、身份、本地凭据和管理员角色。已存在的同名账号不会被提升权限或覆盖密码。初始化完成后可移除两个 bootstrap 配置项及环境变量。不要先公开注册预定的管理员邮箱。

密码采用随机盐与 scrypt（N=32768、r=8、p=3），不存明文。邮箱按 NFKC、去除首尾空格、小写规范化，只作为登录名，每个认证实例内独立唯一。邮箱验证、密码找回与修改、MFA、SSO 和群聊适配尚未实现。

## 页面与 API

页面 `/auth/local/:providerId` 包含登录、注册及按权限显示的用户、角色管理面板。注册不自动登录，也不授予角色。用户列表每页 50 个，只返回当前认证实例账号，不返回密码哈希。

| 方法 | 路径（前缀 `/api/auth/local/:providerId`） | 请求或要求                                                  |
| ---- | ------------------------------------------ | ----------------------------------------------------------- |
| POST | `/register`                                | `{email, password, displayName}`，需开启注册                |
| POST | `/login`                                   | `{email, password}`，成功设置 Cookie                        |
| GET  | `/users?offset=0`                          | `identity.local.manage`                                     |
| PUT  | `/users/:accountId/status`                 | `identity.local.manage`，`{status: 'active' 或 'disabled'}` |

登录凭据错误统一返回“邮箱或密码错误”；注册重复邮箱返回 409。单实例对同一来源 IP 每分钟最多接受 20 次登录或注册请求，同时最多进行两次密码计算。限流保存在进程内，多副本需要外部限流设施。

local 通过 database 跨插件事务和 RBAC 服务写入身份，自己只操作 account 私有表。账号重复或创建失败时整体回滚，不产生孤立主体。卸载不删除账号，重载要求重新登录。
