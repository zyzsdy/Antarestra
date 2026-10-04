# OneBot 11 接入

通过已有 NapCat 等 OneBot 11 实现接入 QQ，本插件不处理 QQ 登录。依赖 `im` 和 `server`，同一实例只接受一个指定 QQ 账号的 Universal 反向 WebSocket。所有命令、AI 与普通消息插件继续由 Cordis 管理。

## 本机浅浅账号

在已被 Git 忽略的 `.env` 设置随机令牌 `ANTARESTRA_ONEBOT_TOKEN`，主配置使用环境变量引用：

```yaml
im-onebot:
  id: qq-qianqian
  label: 浅浅
  selfId: '152408856'
  token: $ANTARESTRA_ONEBOT_TOKEN
  path: /im/onebot/qq-qianqian
  policy:
    private:
      mode: whitelist
      ids: []
    group:
      mode: whitelist
      ids: ['40894918']
```

以上条目放在主配置的 `plugins` 映射下。若配置多个 OneBot 插件，映射键使用 `im-onebot:八位随机十六进制哈希`；`id` 必须在所有 IM 接入中唯一且保持稳定。账号和聊天 ID 全部使用字符串。

NapCat WebUI 的网络配置中新建 **WebSocket 客户端（反向 WebSocket）**，地址填写 `ws://127.0.0.1:14451/im/onebot/qq-qianqian`，令牌与环境变量一致，消息格式选择 `array`，连接角色选择 `Universal`（同时收事件和调用 API）。地址没有 `/api` 前缀。如 NapCat 在其他机器，替换为 Antarestra 的可达地址并通过安全的网络连接。

`token` 与 `tokenEnv` 二选一；`tokenEnv` 从运行进程的环境变量读取，而 `.env` 由项目加载器替换时应使用上例 `token` 写法。不设置准入规则时拒绝所有聊天。以上白名单在适配器入口和出口都检查，因此后台策略不能扩大到其他群或私聊。修改范围需明确修改接入配置。

## 支持范围

- 入站：数组与 CQ 字符串的文本、@、引用、图片、视频、音频、文件；群上传通知通过文件 URL 或资源 ID 下载。原始事件、发送者和群主/管理员角色保留。
- 出站：文本、@、引用、图片、视频和音频。通用 OneBot 11 消息接口不支持文件发送，因此明确返回不支持。
- 能力调用：成员查询、群禁言、移除群成员。业务插件必须自行检查操作者和机器人平台权限；适配器不自行赋予群管理权限。
- 合并转发：保留数组与 CQ 消息中的资源 ID，AI 输入显示 `[合并转发,资源ID]`，可通过工具主动读取内部内容。
- 连接验证同时检查令牌、`X-Self-ID` 和 `X-Client-Role`。事件中的账号还会再次检查。
- 自身回声、`message_sent`、明确标记的机器人和 `ignoredUserIds` 中的账号仍进入群消息归档，但不触发命令与 AI。OneBot 11 不能可靠识别所有第三方机器人。
- RPC 使用唯一 echo，默认 15 秒超时；断连、重连替换、取消和插件卸载均清理待处理请求。发送超时属于结果未知，不保证平台绝无重复。
- 适配器识别本次运行最近 1000 条机器人回复；IM 核心还会用当前空间的持久化归档验证更早引用。

测试使用真实本地 WebSocket 和受控 OneBot 对端，验证鉴权、目标白名单、发送、超时、重连及卸载；此测试本身不代表真实 QQ 端验收。

## AI 工具

AI 服务可用时自动注册以下工具，未加载 AI 服务不影响 OneBot 接入。在助理的工具列表中启用对应工具后，AI 才能调用：

| 工具                        | 参数与用途                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onebot_get_forward_msg`    | 必填 `message_id` 为包含合并转发的外层原始消息 ID；可选 `id` 为该消息中指定的合并转发资源 ID，省略时读取第一个。调用 `get_msg` 核验消息和资源归属，再调用 `get_forward_msg`，保留节点、发送者、时间与内容，并将图片转换为当前空间的文件资源 ID。 |
| `onebot_set_msg_emoji_like` | 必填 `message_id` 和 `emoji_id`，调用 NapCat `set_msg_emoji_like`，固定 `set: true` 为消息添加表态。工具描述完整列出表情外观和使用含义。                                                                                                         |

所有 ID 均以字符串传入。表态可选 ID：续标识 `424`、问号 `10068`、捂脸 `264`、紧张 `128560`、辣眼睛 `265`、赞 `76`、NO `123`、大哭 `128557`、拥抱 `49`、爱心 `66`。

转发结果中的 CQ 图片替换为 `[图片,资源ID]`，数组图片段返回 `data.resourceId` 及图片元数据；`message`、`content`、`raw_message` 和内嵌节点都会处理，同一次调用中相同下载地址只保存一次。助理还需启用 `workspace_file_read`，使用 `{ "resourceId": "资源ID" }` 按需查看图片。转换依赖 `workspace-file` 的图片存储，支持 PNG、JPEG、GIF、WebP，单张最多 8 MiB。图片下载、识别或保存失败时保留失败提示，其他节点继续返回；不会把平台图片 URL 或本地文件路径当成内部资源 ID。

工具从可信 AI 运行的工作空间解析接入账号和聊天，不接受模型指定其他账号、群或工作空间；只能访问当前空间已记录的原始消息，并遵守接入白名单及在线禁用策略。平台无法读取的过期或已撤回消息会返回错误；表态需要 NapCat 或兼容该扩展的实现。调用取消、超时、断连或卸载时清理待处理请求；表态结果未知时不自动重试。

接口参数对照 NapCat 官方实现：[合并转发](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts)、[消息表态](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/msg/SetMsgEmojiLike.ts)。

群媒体下载到 workspace-file，失败保留元数据并重试。消息输入模板、历史条数、附件数量和媒体清理全部在“IM 接入”面板配置；适配器不再提供 context/recentLimit 配置。

没有直链的媒体通过 get_image、get_record 或 get_file 获取 URL/二进制，语音请求 MP3。仅返回机器人主机本地路径时不会读取 Antarestra 本地文件；平台必须提供可访问 URL 或 base64，否则保留失败状态。NapCat 的相关能力与配置见[官方文件处理说明](https://napneko.github.io/develop/file)。
