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

- 入站：文本、@、引用、图片 URL、文件 URL；发送者和群主/管理员角色保留。
- 出站：文本、@、引用、图片。通用 OneBot 11 消息接口不支持文件发送，因此明确返回不支持。
- 能力调用：成员查询、群禁言、移除群成员。业务插件必须自行检查操作者和机器人平台权限；适配器不自行赋予群管理权限。
- 连接验证同时检查令牌、`X-Self-ID` 和 `X-Client-Role`。事件中的账号还会再次检查。
- 忽略自身回声、`message_sent` 事件、明确标记为机器人的成员。OneBot 11 不能可靠识别所有第三方机器人，可配置 `ignoredUserIds` 排除其账号。
- RPC 使用唯一 echo，默认 15 秒超时；断连、重连替换、取消和插件卸载均清理待处理请求。发送超时属于结果未知，不保证平台绝无重复。
- 回复机器人激活仅识别本次运行中最近 1000 条本机器人发出的消息；重启后不会把无法验证的引用误判为机器人消息。

测试使用真实本地 WebSocket 和受控 OneBot 对端，验证鉴权、目标白名单、发送、超时、重连及卸载；此测试本身不代表真实 QQ 端验收。
