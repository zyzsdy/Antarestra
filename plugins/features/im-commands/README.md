# IM 固定命令

插件包：`@antarestra/plugin-im-commands`。依赖 `im`、`rbac`，不依赖 AI 服务。

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

`permission` 可指定已在 RBAC 声明的权限；执行前使用当前可信 IM 身份再次鉴权，帮助列表只显示有权限的命令。群管理员不是系统管理员。成员管理业务应独立检查平台群身份与机器人平台权限，然后调用 IM 的平台能力。

命令按整个首个单词精确匹配。命中后无论参数错误、权限不足还是执行失败均消费消息，不继续进入 AI；聊天关闭命令时也消费已注册命令。未注册命令继续传给其他消息处理器，因此 `/ai` 可以由 AI 插件处理。

`execute` 收到 `CommandContext`，含 `args`、`rawArgs`、可信 `request`、`actorId`、`workspaceId`、`message`、`connection`、`reply` 与 `signal`。返回字符串会自动回复，也可以调用 `reply` 自行发送消息。耗时操作必须响应 `signal`；卸载所属插件会撤销命令、取消信号并等待活动命令清理。

内置 `/ping` 回复 `pong`，`/help` 列出可用命令。可用 `builtins: false` 关闭内置命令。普通命令不受 AI 的激活条件影响。
