# IM 固定命令

插件包：`@antarestra/plugin-im-commands`。依赖数据库、`im`、`rbac`，不依赖 AI 服务。

通过 `ctx.imCommands.register(owner, command)` 注册命令。业务插件仍然由 Cordis 加载、注入和卸载；本服务只负责命令解析与执行，没有独立插件目录或插件生命周期。

```ts
import type { Context } from '@antarestra/plugin-sdk'
import '@antarestra/plugin-im-commands'

export const inject = ['imCommands']
export function apply(ctx: Context) {
  ctx.imCommands.register(ctx, {
    name: 'echo',
    description: '回显一段文本',
    usage: '<文本>',
    minArgs: 1,
    maxArgs: 1,
    execute: ({ args }) => args[0],
  })
}
```

默认前缀为 `/`，支持单双引号和反斜线转义，例如 `/echo "两个 参数"`。命令名称只能使用小写字母开头的字母、数字、下划线与连字符；重复注册明确拒绝。

`access` 将指令分为 `user`（默认普通用户）和 `bot-admin`（当前群 bot 管理员）。普通指令允许激活聊天中的用户执行；bot 管理指令仅在群聊中可用。`permission` 可额外指定 RBAC 权限，与命令类别同时校验；帮助列表只显示当前有权限的命令。

群主自动拥有所在群的 bot 管理权限，按接入的当前成员查询结果判断，不把群主写入永久名单；群主转移后权限随之转移。平台群管理员不自动拥有 bot 管理权限。OneBot 使用当前群成员角色，飞书在成员验证后查询[群信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get)中的群主 open_id；平台无法验证群主时不提升权限。

`/admin add <id>` 由本插件提供，仅当前群的 bot 管理员可执行，名单按已验证的工作空间持久化，不会把管理员权限扩散到其他群或私聊。群主与额外管理员都可以添加新的额外管理员。也可在控制台“群消息与 AI 会话”列表点击对应群的“bot 管理员”，编辑或删除额外名单；控制台需要 `admin.console.view`、`admin.im.history.view` 和 `admin.im.bot.manage`，并使用修订号防止并发覆盖。群主的自动权限不能通过清空额外名单移除。

现有 `/ping`、`/help`、`/stop`、`/reset` 为普通用户命令，`/admin` 和 `/sticker` 为 bot 管理命令；AI 插件处理的 `/ai` 继续按普通 AI 入口授权。新增管理指令应声明 `access: 'bot-admin'`。bot 管理员不是网站/系统管理员，也不会自动获得平台管理接口权限。

命令按整个首个单词精确匹配。命中后无论参数错误、权限不足还是执行失败均消费消息，不继续进入 AI；聊天关闭命令时也消费已注册命令。未注册命令继续传给其他消息处理器，因此 `/ai` 可以由 AI 插件处理。

`execute` 收到 `CommandContext`，含 `args`、`rawArgs`、可信 `request`、`actorId`、`workspaceId`、`message`、`connection`、`reply` 与 `signal`。返回字符串会自动回复，也可以调用 `reply` 自行发送消息。耗时操作必须响应 `signal`；卸载所属插件会撤销命令、取消信号并等待活动命令清理。

内置 `/ping` 回复 `pong`，`/help` 列出可用命令。可用 `builtins: false` 关闭 ping/help；`/admin` 始终注册。普通命令不受 AI 的激活条件影响。
