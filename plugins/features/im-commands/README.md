# IM 固定命令

插件包：`@antarestra/plugin-im-commands`。依赖数据库、`im`、`rbac`，不依赖 AI 服务。

通过 `ctx.imCommands.register(owner, command)` 注册命令。业务插件仍然由 Cordis 加载、注入和卸载；本服务统一负责命令解析、群聊/私聊名单、授权级别与执行，没有独立插件目录或插件生命周期。业务插件不需要重复实现指令名单。

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

## 集中配置指令权限

在 `im-commands.commands` 中按去掉前缀后的**完整首个单词**配置，例如 `/sticker add 标题` 和 `/sticker delete 标题` 共用 `sticker` 规则，`/sticker-other` 不会命中。修改前缀后配置键不变。可在插件配置面板的“IM 命令”中编辑 `commands` JSON 对象，或切换 YAML；也可修改主配置：

```yaml
plugins:
  im-commands:
    prefix: /
    commands:
      sticker:
        access: bot-admin
        group:
          mode: whitelist
          ids: ['群号一', '群号二']
        private:
          mode: whitelist
          ids: ['允许管理表情包的用户号']
      ping:
        access: user
        group:
          mode: blacklist
          ids: ['禁用此指令的群号']
        private:
          mode: blacklist
          ids: ['禁用此指令的用户号']
      ai:
        group:
          mode: whitelist
          ids: ['允许命令唤起 AI 的群号']
```

群聊与私聊分别选择名单模式：`whitelist` 只允许 `ids` 内的聊天，`blacklist` 允许名单外的聊天。群聊填写群 ID，私聊填写用户 ID；空白名单全部拒绝，空黑名单全部允许。名单按聊天 ID 匹配，对本命令服务管理的各接入生效；每个接入原有的准入范围仍是上限。

| 场景             | 名单通过后的授权规则                                    |
| ---------------- | ------------------------------------------------------- |
| 群聊 `user`      | 所有群友可执行                                          |
| 群聊 `bot-admin` | 仅当前群 bot 管理员和群主可执行，平台群管理员不自动授权 |
| 私聊，任一级别   | 不检查指令级别，也不查询群管理员身份                    |

名单先于授权级别检查；群主和 bot 管理员也不能绕过名单。未配置某条指令或某个聊天类型的名单时，不增加指令名单限制，沿用接入层准入范围和命令开关。**高级命令在私聊中也遵循此规则**，需要限定私聊使用者时应显式配置私聊白名单。名单拒绝会静默消费消息，不报参数错误，也不继续落入 AI。

`commands.<名称>.access` 可覆盖插件注册时声明的 `access`。未配置则沿用插件声明，插件也未声明则为 `user`。`permission` 可额外指定业务 RBAC 权限，群聊和私聊均保留这项校验；指令级别不会赋予网站/系统管理权限。`/help` 按相同的名单、有效级别和 RBAC 权限过滤已注册命令。

## 群管理员与插件接入

群主自动拥有所在群的 bot 管理权限，按接入的当前成员查询结果判断，不把群主写入永久名单；群主转移后权限随之转移。平台群管理员不自动拥有 bot 管理权限。OneBot 使用当前群成员角色，飞书在成员验证后查询[群信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get)中的群主 open_id；平台无法验证群主时不提升权限。

`/admin add <id>` 由本插件提供，默认需要当前群的 bot 管理员权限，也遵循集中配置的名单和级别覆盖。名单按已验证的工作空间持久化，不会把管理员权限扩散到其他群或私聊。默认群主与额外管理员都可以添加新的额外管理员。此操作必须有当前群上下文，因此在私聊中会提示仅可在群聊使用。也可在控制台“群消息与 AI 会话”列表点击对应群的“bot 管理员”，编辑或删除额外名单；控制台需要 `admin.console.view`、`admin.im.history.view` 和 `admin.im.bot.manage`，并使用修订号防止并发覆盖。群主的自动权限不能通过清空额外名单移除。

现有 `/ping`、`/help`、`/stop`、`/reset` 默认是普通用户命令，`/admin` 和 `/sticker` 默认是 bot 管理命令。新增管理指令应声明 `access: 'bot-admin'`，由集中配置决定最终级别。

命令按整个首个单词精确匹配。命中后无论参数错误、权限不足还是执行失败均消费消息，不继续进入 AI；聊天关闭命令时也消费已注册命令。未注册但存在集中配置的命令（例如 `commands.ai`）会先检查名单和级别，通过后才交给其他处理器，拒绝则消费；关闭聊天命令开关同样会拒绝。未注册且未配置的首词继续传给其他消息处理器。

`/ai` 等由 AI 激活规则处理的入口可用上述方式配置；仍须匹配 `im-commands.prefix`，配置本身不会注册命令，也不会修改 AI 激活条件。`@`、关键词等非命令激活方式继续由 AI 聊天策略控制。帮助列表只列出实际注册并提供描述的命令。

`execute` 收到 `CommandContext`，含 `args`、`rawArgs`、可信 `request`、`actorId`、`workspaceId`、`message`、`connection`、`reply` 与 `signal`。返回字符串会自动回复，也可以调用 `reply` 自行发送消息。耗时操作必须响应 `signal`；卸载所属插件会撤销命令、取消信号并等待活动命令清理。

内置 `/ping` 回复 `pong`，`/help` 列出可用命令。可用 `builtins: false` 关闭 ping/help；`/admin` 始终注册。普通命令不受 AI 的激活条件影响。
