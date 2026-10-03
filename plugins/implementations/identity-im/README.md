# IM 身份映射

依赖 `database`、`rbac`、`im`，通过 `ctx.identityIm` 管理 IM 空间与成员状态。

接入实例、平台、租户、机器人账号共同组成账号范围；该范围与发言者 ID 映射到独立 RBAC 主体。该范围与聊天类型、聊天对象 ID 映射到 Workspace。同群不同成员使用独立 Actor，共享 Workspace；同一用户通过两个机器人账号私聊时，Actor 和 Workspace 均分开。映射持久化，重启或重装插件不会改变 ID。

IM 提供者默认标识为 `im`，不创建本地密码账号、不签发网页登录会话、不自动关联同名本地用户。可信消息入口在当前空间赋予 `user` 默认角色，不继承平台群管理员为系统管理员。RBAC 额外手工角色绑定必须明确指定 Workspace；`system` 绑定不会扩散至群空间。

每次请求验证 IM 成员、Workspace、RBAC 主体、身份和提供者状态。`setMemberActive(actorId, workspaceId, active)` 和 `setWorkspaceActive(workspaceId, active)` 可由受授权业务调用；禁用后再次收到消息不会自动启用。它们是服务端能力，未暴露匿名 HTTP 接口。

后台任务除检查持久化状态外，还要求原接入仍注册并通过适配器 `getMember()` 确认当前成员资格；缺少成员查询能力时拒绝后台恢复。退出群后的历史成员记录不会单独赋予后台执行权限。消息来源对象采用 IM 核心内部登记，不接受前端提交 Actor 或 Workspace 冒充身份。

`im` 请求来源通过 `listWorkspaces` 分页提供已持久化的群聊和私聊目录，包括停用空间，供管理员查看和管理历史文件配额。文件插件无需等待该空间首次文件访问；目录不创建个人空间，也不代替成员和空间授权检查。卸载后停止枚举，文件管理保留已收录记录；重新加载沿用原空间 ID。

配置仅包含可选 `providerId`，修改它会改变 RBAC 提供者，已有身份应保持原值。
